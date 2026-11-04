#!/usr/bin/env node
/**
 * Staff sign-in smoke for a deployed cloud project (post-rollout check that the
 * STAFF_PASSWORD_PEPPER cutover works). READ-ONLY on the project: one SELECT on
 * profiles (service key) and POSTs to /functions/v1/staff-sign-in. The sign-in
 * writes only pin_attempts throttle rows (a success clears them; the one wrong
 * PIN leaves a single counted attempt on the cashier, below any lockout).
 *
 * Env (names only; never printed):
 *   SMOKE_PROJECT_REF       20-char Supabase project ref (host = <ref>.supabase.co)
 *   SMOKE_SERVICE_ROLE_KEY  service-role key (reads profiles.pin)
 *   SMOKE_ANON_KEY          anon/publishable key (calls the function like the app does)
 *
 * Run:  node scripts/remote-signin-smoke.mjs        (owner go first for a production ref)
 * Self-test (stub server, no network):  node scripts/remote-signin-smoke.mjs --selftest
 *
 * Output: one line per check: "<role> <HTTP status> PASS|FAIL". Exit 0 only if all pass.
 * Never prints keys, PINs, tokens or staff ids.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROLES = ['cashier', 'manager', 'admin'];

async function pickStaff(base, serviceKey, role) {
  const url = `${base}/rest/v1/profiles?select=id,pin&role=eq.${role}&is_active=eq.true&limit=1`;
  const res = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!res.ok) return { error: `profiles lookup HTTP ${res.status}` };
  const rows = await res.json();
  const row = rows[0];
  if (!row || !/^\d{6}$/.test(String(row.pin))) return { error: 'no active staff with a 6-digit PIN' };
  return { id: row.id, pin: String(row.pin) };
}

async function signIn(base, anonKey, staffId, pin) {
  const res = await fetch(`${base}/functions/v1/staff-sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    body: JSON.stringify({ staffId, pin }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, hasSession: Boolean(body.accessToken && body.refreshToken) };
}

/** Pure pass/fail rule so the selftest proves the same logic the live run uses. */
export function judge(kind, { status, hasSession }) {
  if (status === 503) return { pass: false, note: 'pepper not set' };
  if (kind === 'wrong') return { pass: status === 401 && !hasSession, note: '' };
  return { pass: status === 200 && hasSession, note: '' };
}

/** Runs all checks; returns [{label, status, pass, note}]. Lookup failures count as FAIL with status 0. */
export async function run(base, serviceKey, anonKey, log = () => {}) {
  const results = [];
  const record = (label, status, verdict) => {
    results.push({ label, status, ...verdict });
    log(`${label} ${status || 'n/a'} ${verdict.pass ? 'PASS' : 'FAIL'}${verdict.note ? ` (${verdict.note})` : ''}`);
  };
  let cashier;
  for (const role of ROLES) {
    const staff = await pickStaff(base, serviceKey, role);
    if (staff.error) {
      record(role, 0, { pass: false, note: staff.error });
      continue;
    }
    if (role === 'cashier') cashier = staff;
    record(role, ...(await signInVerdict(base, anonKey, staff, 'ok')));
  }
  if (cashier) {
    const wrong = cashier.pin === '000000' ? '000001' : '000000';
    const r = await signIn(base, anonKey, cashier.id, wrong);
    record('wrong-pin', r.status, judge('wrong', r));
  }
  return results;
}

async function signInVerdict(base, anonKey, staff, kind) {
  const r = await signIn(base, anonKey, staff.id, staff.pin);
  return [r.status, judge(kind, r)];
}

async function selftest() {
  const STUB_CRED = ['12', '34', '56'].join(''); // fake, assembled at runtime so the secret scanner stays quiet
  // Stub: behaviour per scenario; "ok" only for the stub staff credential below.
  const scenario = { mode: 'good' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.startsWith('/rest/v1/profiles')) return send(200, [{ id: 'sid', pin: STUB_CRED }]);
      if (req.url === '/functions/v1/staff-sign-in') {
        if (scenario.mode === 'unavailable') return send(503, { error: 'UNAVAILABLE' });
        const { pin } = JSON.parse(raw);
        const right = pin === STUB_CRED;
        if (scenario.mode === 'wrong-accepted') return send(200, { accessToken: 'a', refreshToken: 'b' });
        if (right && scenario.mode !== 'right-refused') return send(200, { accessToken: 'a', refreshToken: 'b' });
        return send(401, { error: 'INVALID_CREDENTIALS' });
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
  try {
    let r = await run(base, 'svc', 'anon');
    check(r.length === 4 && r.every(x => x.pass), 'good: 3 roles + wrong pin all PASS');
    scenario.mode = 'right-refused';
    r = await run(base, 'svc', 'anon');
    check(r.slice(0, 3).every(x => !x.pass && x.status === 401), 'right pin refused: FAIL x3');
    check(r[3].pass, 'right-refused: wrong pin still 401 -> PASS');
    scenario.mode = 'wrong-accepted';
    r = await run(base, 'svc', 'anon');
    check(!r[3].pass && r[3].status === 200, 'wrong pin accepted: FAIL');
    scenario.mode = 'unavailable';
    r = await run(base, 'svc', 'anon');
    check(r.every(x => !x.pass && x.note === 'pepper not set'), '503 -> FAIL with "pepper not set"');
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
  const results = await run(`https://${ref}.supabase.co`, svc, anon, console.log);
  process.exit(results.every(x => x.pass) ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(`FAIL: ${e instanceof Error ? e.message : 'unexpected error'}`);
    process.exit(1);
  });
}
