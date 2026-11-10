#!/usr/bin/env node
/**
 * Staff sign-in smoke for a deployed cloud project (post-rollout check that staff sign-in
 * and the PIN checks work). Never reads profiles.pin (it is a bcrypt hash since 11H).
 *
 * Default mode: one SELECT of an active staff id per role (service key), then one WRONG-PIN POST
 * to /functions/v1/staff-sign-in per role: 401 proves the function and the pepper are live
 * (503 = pepper not set). It leaves one counted attempt per tried staff member, below any lockout.
 *
 * --temp-cashier: also proves a RIGHT PIN. Makes a throw-away cashier through
 * scripts/lib/ensure-staff-account.ts with a random PIN held only in memory, signs it in, runs
 * verify_staff_pin right and wrong with that session, then deactivates it (even on failure).
 * Needs STAFF_PASSWORD_PEPPER (this project's) and runs through tsx:
 *   npx tsx scripts/remote-signin-smoke.mjs --temp-cashier
 *
 * Env (names only; never printed):
 *   SMOKE_PROJECT_REF       20-char Supabase project ref (host = <ref>.supabase.co)
 *   SMOKE_SERVICE_ROLE_KEY  service-role key
 *   SMOKE_ANON_KEY          anon/publishable key (calls the function like the app does)
 *   STAFF_PASSWORD_PEPPER   --temp-cashier only
 *
 * Run:  node scripts/remote-signin-smoke.mjs        (owner go first for a production ref)
 * Self-test (stub server, no network):  node scripts/remote-signin-smoke.mjs --selftest
 *
 * Output: one line per check: "<label> <HTTP status> PASS|FAIL". Exit 0 only if all pass.
 * Never prints keys, PINs, tokens or staff ids.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROLES = ['cashier', 'manager', 'admin'];
const randomPin = () => String(randomInt(100000, 1000000));
const svcHeaders = key => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

async function pickStaff(base, serviceKey, role) {
  const url = `${base}/rest/v1/profiles?select=id&role=eq.${role}&is_active=eq.true&limit=1`;
  const res = await fetch(url, { headers: svcHeaders(serviceKey) });
  if (!res.ok) return { error: `profiles lookup HTTP ${res.status}` };
  const row = (await res.json())[0];
  return row ? { id: row.id } : { error: 'no active staff' };
}

async function signIn(base, anonKey, staffId, pin) {
  const res = await fetch(`${base}/functions/v1/staff-sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    body: JSON.stringify({ staffId, pin }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, hasSession: Boolean(body.accessToken && body.refreshToken), accessToken: body.accessToken };
}

async function verifyPin(base, anonKey, accessToken, staffId, pin) {
  const res = await fetch(`${base}/rest/v1/rpc/verify_staff_pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ p_pin: pin, p_staff_id: staffId }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: body?.ok === true, code: body?.code };
}

/** Pure pass/fail rule so the selftest proves the same logic the live run uses. */
export function judge(kind, { status, hasSession }) {
  if (status === 503) return { pass: false, note: 'pepper not set' };
  if (kind === 'wrong') return { pass: status === 401 && !hasSession, note: '' };
  return { pass: status === 200 && hasSession, note: '' };
}

function recorder(log) {
  const results = [];
  const record = (label, status, verdict) => {
    results.push({ label, status, ...verdict });
    log(`${label} ${status || 'n/a'} ${verdict.pass ? 'PASS' : 'FAIL'}${verdict.note ? ` (${verdict.note})` : ''}`);
  };
  return { results, record };
}

/** Default mode (no PIN needed): a wrong PIN must be refused with 401 for one staff member per role. */
export async function run(base, serviceKey, anonKey, log = () => {}) {
  const { results, record } = recorder(log);
  for (const role of ROLES) {
    const staff = await pickStaff(base, serviceKey, role);
    if (staff.error) {
      record(`${role}-wrong-pin`, 0, { pass: false, note: staff.error });
      continue;
    }
    const r = await signIn(base, anonKey, staff.id, randomPin());
    record(`${role}-wrong-pin`, r.status, judge('wrong', r));
  }
  return results;
}

/**
 * --temp-cashier: `ensure(name, pin)` creates the cashier (ensure-staff-account); the PIN lives
 * only in this function. The cashier is deactivated in `finally`.
 */
export async function runTempCashier(base, serviceKey, anonKey, ensure, log = () => {}) {
  const { results, record } = recorder(log);
  const name = `Smoke Cashier ${Date.now()}`;
  const pin = randomPin();
  const wrong = pin === '000000' ? '000001' : '000000';
  let id;
  try {
    await ensure(name, pin);
    const res = await fetch(`${base}/rest/v1/profiles?select=id&name=eq.${encodeURIComponent(name)}`, {
      headers: svcHeaders(serviceKey),
    });
    id = res.ok ? (await res.json())[0]?.id : undefined;
    if (!id) {
      record('temp-cashier', res.status, { pass: false, note: 'cashier not found after ensure' });
      return results;
    }
    const s = await signIn(base, anonKey, id, pin);
    record('temp-cashier-sign-in', s.status, judge('ok', s));
    if (s.accessToken) {
      const right = await verifyPin(base, anonKey, s.accessToken, id, pin);
      record('verify-pin-right', right.status, { pass: right.status === 200 && right.ok, note: '' });
      const bad = await verifyPin(base, anonKey, s.accessToken, id, wrong);
      record('verify-pin-wrong', bad.status, {
        pass: bad.status === 200 && !bad.ok && bad.code === 'INVALID_PIN',
        note: '',
      });
    }
  } finally {
    if (id) {
      const d = await fetch(`${base}/rest/v1/profiles?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...svcHeaders(serviceKey), Prefer: 'return=minimal' },
        body: JSON.stringify({ is_active: false }),
      });
      record('deactivate', d.status, { pass: d.ok, note: d.ok ? '' : 'temp cashier left ACTIVE: deactivate it by hand' });
    }
  }
  return results;
}

async function selftest() {
  const scenario = { mode: 'good', pin: '', urls: [], deactivated: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(obj === undefined ? undefined : JSON.stringify(obj));
      };
      scenario.urls.push(req.url);
      if (req.method === 'PATCH' && req.url.startsWith('/rest/v1/profiles')) {
        scenario.deactivated = true;
        return send(204);
      }
      if (req.url.startsWith('/rest/v1/profiles')) return send(200, [{ id: 'sid' }]);
      if (req.url === '/functions/v1/staff-sign-in') {
        if (scenario.mode === 'unavailable') return send(503, { error: 'UNAVAILABLE' });
        const { pin } = JSON.parse(raw);
        if (scenario.mode === 'wrong-accepted') return send(200, { accessToken: 'a', refreshToken: 'b' });
        if (pin === scenario.pin && scenario.mode !== 'right-refused') {
          return send(200, { accessToken: 'a', refreshToken: 'b' });
        }
        return send(401, { error: 'INVALID_CREDENTIALS' });
      }
      if (req.url === '/rest/v1/rpc/verify_staff_pin') {
        const right = JSON.parse(raw).p_pin === scenario.pin;
        return send(200, right ? { ok: true } : { ok: false, code: 'INVALID_PIN' });
      }
      return send(404, {});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let asserts = 0;
  const check = (cond, msg) => {
    assert.ok(cond, msg);
    asserts++;
  };
  const ensure = async (_name, pin) => {
    scenario.pin = pin;
  };
  try {
    let r = await run(base, 'svc', 'anon');
    check(r.length === 3 && r.every(x => x.pass), 'default: wrong PIN refused 401 for every role');
    check(scenario.urls.every(u => !/pin/.test(u)), 'default: profiles.pin is never selected');
    scenario.mode = 'wrong-accepted';
    r = await run(base, 'svc', 'anon');
    check(r.every(x => !x.pass && x.status === 200), 'wrong PIN accepted: FAIL');
    scenario.mode = 'unavailable';
    r = await run(base, 'svc', 'anon');
    check(r.every(x => !x.pass && x.note === 'pepper not set'), '503 -> FAIL with "pepper not set"');

    scenario.mode = 'good';
    scenario.urls = [];
    r = await runTempCashier(base, 'svc', 'anon', ensure);
    check(r.length === 4 && r.every(x => x.pass), 'temp cashier: sign-in, verify right, verify wrong, deactivate PASS');
    check(scenario.deactivated, 'temp cashier: deactivated');
    check(scenario.urls.every(u => !/select=[^&]*pin/.test(u)), 'temp cashier: profiles.pin is never selected');

    scenario.mode = 'right-refused';
    scenario.deactivated = false;
    r = await runTempCashier(base, 'svc', 'anon', ensure);
    check(!r[0].pass && r[0].status === 401, 'right PIN refused: sign-in FAIL');
    check(scenario.deactivated, 'right PIN refused: the cashier is still deactivated');
  } finally {
    server.close();
  }
  console.log(`selftest OK (${asserts} assertions)`);
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const { SMOKE_PROJECT_REF: ref, SMOKE_SERVICE_ROLE_KEY: svc, SMOKE_ANON_KEY: anon } = process.env;
  const missing = ['SMOKE_PROJECT_REF', 'SMOKE_SERVICE_ROLE_KEY', 'SMOKE_ANON_KEY'].filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`missing env: ${missing.join(', ')}`);
    process.exit(2);
  }
  if (!/^[a-z0-9]{20}$/.test(ref)) {
    console.error('SMOKE_PROJECT_REF must be a 20-character project ref');
    process.exit(2);
  }
  const base = `https://${ref}.supabase.co`;
  let results;
  if (process.argv.includes('--temp-cashier')) {
    const [{ createClient }, { ensureStaffAccount }] = await Promise.all([
      import('@supabase/supabase-js'),
      import('./lib/ensure-staff-account.ts'),
    ]);
    const db = createClient(base, svc, { auth: { persistSession: false, autoRefreshToken: false } });
    results = await runTempCashier(base, svc, anon, (name, pin) => ensureStaffAccount(db, 'cashier', name, pin), console.log);
  } else {
    results = await run(base, svc, anon, console.log);
  }
  process.exit(results.every(x => x.pass) ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(`FAIL: ${e instanceof Error ? e.message : 'unexpected error'}`);
    process.exit(1);
  });
}
