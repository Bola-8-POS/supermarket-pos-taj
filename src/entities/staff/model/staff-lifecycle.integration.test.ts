/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: staff lifecycle (set-staff-active, change-own-pin) on the
 * local stack with the edge runtime running.
 *
 * Run: npx vitest run src/entities/staff/model/staff-lifecycle.integration.test.ts
 * Note: the local Auth service allows 30 sign-ins per 5 minutes per address;
 * this file performs seven.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__lifecycle_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));
const otherPin = (pin: string): string => String((Number(pin) + 1) % 900000 + 100000);

interface Fixture {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'cashier';
  pin: string;
  mustChangePin: boolean;
}

describe.skipIf(skip)('staff lifecycle', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const admin: Fixture = { id: '', name: `${TAG}admin`, email: `${TAG}a_${stamp}@test.local`, role: 'admin', pin: randomPin(), mustChangePin: false };
  // A manager: role-gated RPCs answer it while active, so their refusal after deactivation is meaningful.
  const member: Fixture = { id: '', name: `${TAG}member`, email: `${TAG}m_${stamp}@test.local`, role: 'manager', pin: randomPin(), mustChangePin: false };
  const changer: Fixture = { id: '', name: `${TAG}changer`, email: `${TAG}p_${stamp}@test.local`, role: 'cashier', pin: randomPin(), mustChangePin: true };
  const fixtures = [admin, member, changer];

  let adminToken = '';
  let memberClient: any = null;

  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;

  async function callFn(name: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  const signIn = (f: Fixture, pin: string) => callFn('staff-sign-in', anonKey!, { staffId: f.id, pin });

  async function sessionClient(json: { accessToken: string; refreshToken: string }): Promise<any> {
    const client = anon();
    const { error } = await client.auth.setSession({ access_token: json.accessToken, refresh_token: json.refreshToken });
    if (error) throw new Error(`setSession: ${error.message}`);
    return client;
  }

  async function makeFixture(f: Fixture): Promise<void> {
    // The Auth password equals the PIN, as create-staff sets it.
    const { data, error } = await db.auth.admin.createUser({ email: f.email, password: f.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    f.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({
      id: f.id, name: f.name, email: f.email, role: f.role, pin: f.pin, is_active: true, must_change_pin: f.mustChangePin,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
  }

  async function removeFixture(f: Fixture): Promise<void> {
    if (!f.id) return;
    const { error: attemptsErr } = await db.from('pin_attempts').delete().like('attempt_key', `%${f.id}%`);
    if (attemptsErr) throw new Error(`pin_attempts cleanup for ${f.name}: ${attemptsErr.message}`);
    const { error: profileErr } = await db.from('profiles').delete().eq('id', f.id);
    if (profileErr) throw new Error(`profile delete for ${f.name}: ${profileErr.message}`);
    const { error: authErr } = await db.auth.admin.deleteUser(f.id);
    if (authErr) throw new Error(`auth user delete for ${f.name}: ${authErr.message}`);
  }

  async function inDirectory(id: string): Promise<boolean> {
    const { data, error } = await anon().from('staff_directory').select('id').eq('id', id);
    if (error) throw new Error(`staff_directory: ${error.message}`);
    return (data ?? []).length === 1;
  }

  beforeAll(async () => {
    for (const f of fixtures) await makeFixture(f);

    const adminClient = anon();
    const { data, error } = await adminClient.auth.signInWithPassword({ email: admin.email, password: admin.pin });
    if (error || !data.session) throw new Error(`admin sign in: ${error?.message}`);
    adminToken = data.session.access_token;

    const signedIn = await signIn(member, member.pin);
    if (signedIn.status !== 200) throw new Error(`member sign in: ${signedIn.status}`);
    memberClient = await sessionClient(signedIn.json);
  });

  afterAll(async () => {
    for (const f of fixtures) await removeFixture(f);
    // Audit rows may stay; every fixture row must be gone.
    const { count, error } = await db.from('profiles').select('id', { count: 'exact', head: true }).like('name', `${TAG}%`);
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  it('starts with an active member that holds a session and appears in the directory', async () => {
    expect(await inDirectory(member.id)).toBe(true);
    const { data, error } = await memberClient.rpc('get_user_role');
    expect(error).toBeNull();
    expect(data).toBe('manager');

    // A role-gated RPC answers the active manager (the target already carries the flag).
    const { data: forced, error: forcedErr } = await memberClient.rpc('force_pin_change', { p_staff_id: changer.id });
    expect(forcedErr).toBeNull();
    expect((forced as any).ok).toBe(true);
  });

  it('lets an admin deactivate the member', async () => {
    const { status, json } = await callFn('set-staff-active', adminToken, { staffId: member.id, active: false, terminalId: 'test' });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, changed: true });

    const { data } = await db.from('profiles').select('is_active, deleted_at').eq('id', member.id).single();
    expect(data.is_active).toBe(false);
    expect(data.deleted_at).not.toBeNull();
  });

  it('hides the deactivated member from the directory, PIN checks and sign-in', async () => {
    expect(await inDirectory(member.id)).toBe(false);

    // The admin session (its token, no second sign-in) checks the member's PIN.
    const { data: verify, error: verifyErr } = await createClient(url!, anonKey!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${adminToken}` } },
    }).rpc('verify_staff_pin', { p_pin: member.pin, p_staff_id: member.id, p_required_action: 'create_order' });
    expect(verifyErr).toBeNull();
    expect((verify as any).ok).toBe(false);

    const { status, json } = await signIn(member, member.pin);
    expect(status).toBe(401);
    expect(json.error).toBe('INVALID_CREDENTIALS');
  });

  it('strips every role from the session the member already holds', async () => {
    const { data: role, error: roleErr } = await memberClient.rpc('get_user_role');
    expect(roleErr).toBeNull();
    expect(role).toBeNull();

    // The role-gated RPC that answered the same session while active now refuses
    // it at the caller gate, for a colleague and for the member's own record, and
    // the member's record does not pick up the flag.
    for (const target of [changer, member]) {
      const { error: gated } = await memberClient.rpc('force_pin_change', { p_staff_id: target.id });
      expect(gated?.message.startsWith('AUTH_FORBIDDEN'), `force_pin_change on ${target.name}`).toBe(true);
    }
    const { data: kept } = await db.from('profiles').select('must_change_pin').eq('id', member.id).single();
    expect(kept.must_change_pin).toBe(false);

    // Opening a caja is refused and leaves no session behind.
    const { error: cajaErr } = await memberClient.rpc('caja_open', { p_opening_cash: 0, p_opened_by: member.id, p_terminal_id: 'test' });
    expect(cajaErr).not.toBeNull();
    const { count: opened } = await db.from('caja_sessions').select('id', { count: 'exact', head: true }).eq('opened_by', member.id);
    expect(opened).toBe(0);

    // Closing an open caja is refused and the session stays open. The caja is
    // created by the service role so the refusal comes from the caller gate,
    // not from a missing row.
    const { data: caja, error: cajaInsertErr } = await db
      .from('caja_sessions')
      .insert({ opened_by: admin.id, opening_cash: 0, terminal_id: `${TAG}terminal` })
      .select('id')
      .single();
    expect(cajaInsertErr).toBeNull();
    const { data: closed, error: closeErr } = await memberClient.rpc('close_caja_session', {
      p_caja_id: caja!.id, p_closed_by: member.id, p_closing_cash: 0, p_notes: null,
    });
    expect(closeErr).toBeNull();
    expect((closed as any).ok).toBe(false);
    expect((closed as any).error?.code).toBe('PERMISSION_DENIED');
    const { data: cajaAfter } = await db.from('caja_sessions').select('status').eq('id', caja!.id).single();
    expect(cajaAfter?.status).toBe('open');
    const { error: cajaDeleteErr } = await db.from('caja_sessions').delete().eq('id', caja!.id);
    expect(cajaDeleteErr).toBeNull();

    // A read gated through get_user_role() returns nothing.
    const { data: rows, error: readErr } = await memberClient.from('caja_sessions').select('id').limit(1);
    expect(readErr).toBeNull();
    expect(rows).toEqual([]);
  });

  it('reports no change on a repeated deactivation and refuses a self target', async () => {
    const again = await callFn('set-staff-active', adminToken, { staffId: member.id, active: false });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, changed: false });

    const self = await callFn('set-staff-active', adminToken, { staffId: admin.id, active: false });
    expect(self.status).toBe(400);
    expect(self.json.error).toBe('SELF');

    const unknown = await callFn('set-staff-active', adminToken, { staffId: crypto.randomUUID(), active: false });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe('NOT_FOUND');

    // No user session at all (anon key as bearer).
    const noSession = await callFn('set-staff-active', anonKey!, { staffId: member.id, active: false });
    expect(noSession.status).toBe(401);
  });

  // The last-admin rule cannot be exercised here without deactivating the
  // seed admin; scripts/sql/verify-staff-lifecycle.sql asserts the rule is in
  // the RPC body.
  it.skip('refuses to deactivate the last active admin (covered by the catalog assertion)', () => {});

  it('reactivates the member so the directory and sign-in work again', async () => {
    const { status, json } = await callFn('set-staff-active', adminToken, { staffId: member.id, active: true });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, changed: true });

    expect(await inDirectory(member.id)).toBe(true);
    const { data } = await db.from('profiles').select('is_active, deleted_at').eq('id', member.id).single();
    expect(data.is_active).toBe(true);
    expect(data.deleted_at).toBeNull();

    const signedIn = await signIn(member, member.pin);
    expect(signedIn.status).toBe(200);
  });

  it('changes a staff member\'s own PIN in one server-side operation', async () => {
    const signedIn = await signIn(changer, changer.pin);
    expect(signedIn.status).toBe(200);
    expect(signedIn.json.mustChangePin).toBe(true);
    const token = signedIn.json.accessToken as string;
    const client = await sessionClient(signedIn.json);

    const newPin = otherPin(changer.pin);
    const changed = await callFn('change-own-pin', token, { newPin, terminalId: 'test' });
    expect(changed.status).toBe(200);
    expect(changed.json).toEqual({ ok: true });

    const { data } = await db.from('profiles').select('pin, must_change_pin').eq('id', changer.id).single();
    expect(data.must_change_pin).toBe(false);
    expect(data.pin).toBe(newPin);

    // The session that changed the PIN still works.
    const { data: role, error } = await client.rpc('get_user_role');
    expect(error).toBeNull();
    expect(role).toBe('cashier');

    const same = await callFn('change-own-pin', token, { newPin });
    expect(same.status).toBe(400);
    expect(same.json.error).toBe('SAME_PIN');

    const bad = await callFn('change-own-pin', token, { newPin: '12' });
    expect(bad.status).toBe(400);
    // change-own-pin's flat envelope now carries the error
    // code, not a free-text sentence, in `.error` (Contract: envelope
    // 'flat' -> { error: code, ...extra }) -- same as every other flat-
    // family validation failure this wave converted.
    expect(bad.json.error).toBe('VALIDATION_ERROR');

    expect((await signIn(changer, changer.pin)).status).toBe(401);
    expect((await signIn(changer, newPin)).status).toBe(200);
  });
});
