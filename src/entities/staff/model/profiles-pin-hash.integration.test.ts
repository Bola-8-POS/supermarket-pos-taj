/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';

/**
 * Integration test: profiles.pin holds a salted bcrypt hash (Plan 11H T14).
 * Enforcing migration: supabase/migrations/20261107000001_profiles_pin_salted_hash.sql
 * (trigger profiles_hash_pin, CHECK profiles_pin_is_bcrypt, verify_staff_pin,
 * staff_pin_holder, staff_ids_with_pin and its grants).
 *
 * Run: npx vitest run src/entities/staff/model/profiles-pin-hash.integration.test.ts --project integration
 * Needs the local dev2 stack with the edge runtime running.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__pin_hash_test__';
const BCRYPT = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

interface Fixture {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'cashier';
  pin: string;
  client: any;
}

describe.skipIf(skip)('profiles.pin salted hash', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const mk = (role: Fixture['role'], tag: string): Fixture => ({
    id: '', name: `${TAG}${tag}`, email: `${TAG}${tag}_${stamp}@test.local`, role, pin: '', client: null,
  });
  const admin = mk('admin', 'admin');
  const manager = mk('manager', 'manager');
  const cashier = mk('cashier', 'cashier');
  const fixtures = [admin, manager, cashier];
  const bulkIds: string[] = [];

  /** A six-digit value no active profile uses (checked through the hash-aware helper). */
  async function unusedPin(): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const candidate = String(100000 + Math.floor(Math.random() * 900000));
      const { data, error } = await db.rpc('staff_ids_with_pin', { p_pin: candidate });
      if (error) throw new Error(`staff_ids_with_pin: ${error.message}`);
      if ((data ?? []).length === 0) return candidate;
    }
    throw new Error('no unused pin found');
  }

  async function callFn(name: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  const staffSignIn = (id: string, pin: string) => callFn('staff-sign-in', anonKey!, { staffId: id, pin });

  async function makeFixture(f: Fixture): Promise<void> {
    f.pin = await unusedPin();
    const id = crypto.randomUUID();
    const { data, error } = await db.auth.admin.createUser({
      id, email: f.email, password: await deriveStaffPassword(id, f.pin), email_confirm: true,
    });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    f.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').insert({
      id: f.id, name: f.name, email: f.email, role: f.role, pin: f.pin, is_active: true,
    });
    if (profileErr) throw new Error(`profile insert: ${profileErr.message}`);
    f.client = anon();
    const { error: signErr } = await f.client.auth.signInWithPassword({ email: f.email, password: await deriveStaffPassword(f.id, f.pin) });
    if (signErr) throw new Error(`sign in: ${signErr.message}`);
  }

  async function storedPin(id: string): Promise<string> {
    const { data, error } = await db.from('profiles').select('pin').eq('id', id).single();
    if (error) throw new Error(`select pin: ${error.message}`);
    return data.pin as string;
  }

  beforeAll(async () => {
    for (const f of fixtures) await makeFixture(f);
  }, 60_000);

  afterAll(async () => {
    for (const id of [...bulkIds, ...fixtures.map((f) => f.id)].filter(Boolean)) {
      await db.from('pin_attempts').delete().like('attempt_key', `%${id}%`);
      await db.from('profiles').delete().eq('id', id);
      await db.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it('stores a bcrypt hash, never the PIN', async () => {
    for (const f of fixtures) {
      const stored = await storedPin(f.id);
      expect(stored.startsWith('$2')).toBe(true);
      expect(stored).toMatch(BCRYPT);
      expect(stored).not.toBe(f.pin);
    }
    // Same PIN, different salt.
    expect(await storedPin(admin.id)).not.toBe(await storedPin(manager.id));
  });

  it('hashes a plaintext update, passes a $2 value through verbatim, rejects other formats', async () => {
    const fresh = await unusedPin();
    const { error } = await db.from('profiles').update({ pin: fresh }).eq('id', cashier.id);
    expect(error).toBeNull();
    const hashed = await storedPin(cashier.id);
    expect(hashed).toMatch(BCRYPT);
    expect(hashed).not.toBe(fresh);
    cashier.pin = fresh;

    // The compensation path writes a previous stored value back as-is.
    const managerHash = await storedPin(manager.id);
    const { error: verbatimErr } = await db.from('profiles').update({ pin: managerHash }).eq('id', cashier.id);
    expect(verbatimErr).toBeNull();
    expect(await storedPin(cashier.id)).toBe(managerHash);
    const back = await db.from('profiles').update({ pin: cashier.pin }).eq('id', cashier.id);
    expect(back.error).toBeNull();

    for (const bad of ['12345', '1234567', 'abcdef', '$2a$bad']) {
      const { error: badErr } = await db.from('profiles').update({ pin: bad }).eq('id', cashier.id);
      expect(badErr?.message ?? '', `value ${bad}`).toContain('PIN_FORMAT');
    }
  });

  it('verify_staff_pin accepts the right PIN and refuses a wrong one', async () => {
    const wrong = await unusedPin();
    const refused = await cashier.client.rpc('verify_staff_pin', { p_pin: wrong, p_staff_id: null });
    expect(refused.error).toBeNull();
    expect(refused.data.ok).toBe(false);
    expect(refused.data.code).toBe('INVALID_PIN');

    const ok = await cashier.client.rpc('verify_staff_pin', { p_pin: manager.pin, p_staff_id: manager.id });
    expect(ok.error).toBeNull();
    expect(ok.data.ok).toBe(true);
    expect(ok.data.matches.map((m: any) => m.id)).toContain(manager.id);

    // A right PIN bound to the wrong staff id is a miss.
    const other = await cashier.client.rpc('verify_staff_pin', { p_pin: manager.pin, p_staff_id: admin.id });
    expect(other.data.ok).toBe(false);
    await cashier.client.rpc('verify_staff_pin', { p_pin: manager.pin, p_staff_id: manager.id }); // clears the attempt
  });

  it('staff_pin_holder finds a duplicate and honours the exclusion', async () => {
    const holder = await admin.client.rpc('staff_pin_holder', { p_pin: manager.pin, p_exclude_staff_id: null });
    expect(holder.error).toBeNull();
    expect(holder.data).toBe(manager.name);
    const excluded = await admin.client.rpc('staff_pin_holder', { p_pin: manager.pin, p_exclude_staff_id: manager.id });
    expect(excluded.data).toBeNull();
    const free = await admin.client.rpc('staff_pin_holder', { p_pin: await unusedPin(), p_exclude_staff_id: null });
    expect(free.data).toBeNull();
  });

  it.each(['process_refund', 'apply_custom_discount', 'reopen_tab', 'edit_paid_tab'])(
    'manager override %s: the right PIN issues a ticket, a wrong PIN is INVALID_PIN',
    async (action) => {
      const wrong = await unusedPin();
      const refused = await cashier.client.rpc('verify_staff_pin', { p_pin: wrong, p_staff_id: null, p_required_action: action });
      expect(refused.data.ok).toBe(false);
      expect(refused.data.code).toBe('INVALID_PIN');
      // A cashier's own PIN does not hold the action.
      const own = await cashier.client.rpc('verify_staff_pin', { p_pin: cashier.pin, p_staff_id: null, p_required_action: action });
      expect(own.data.ok).toBe(false);
      const ok = await cashier.client.rpc('verify_staff_pin', { p_pin: manager.pin, p_staff_id: null, p_required_action: action });
      expect(ok.error).toBeNull();
      expect(ok.data.ok).toBe(true);
      expect(typeof ok.data.approval_id).toBe('string');
    },
  );

  it('staff_ids_with_pin is for service_role only', async () => {
    const svc = await db.rpc('staff_ids_with_pin', { p_pin: manager.pin });
    expect(svc.error).toBeNull();
    expect(svc.data).toContain(manager.id);
    const none = await db.rpc('staff_ids_with_pin', { p_pin: await unusedPin() });
    expect(none.data).toEqual([]);

    for (const [who, client] of [['anon', anon()], ['authenticated', cashier.client]] as const) {
      const denied = await client.rpc('staff_ids_with_pin', { p_pin: manager.pin });
      expect(denied.error?.code, who).toBe('42501');
    }
  });

  it('the pin column stays unreadable for authenticated callers', async () => {
    const { error } = await cashier.client.from('profiles').select('pin').eq('id', manager.id);
    expect(error).not.toBeNull();
  });

  it('change-own-pin then admin-reset-pin: each new PIN signs in', async () => {
    // Earlier cases edited profiles.pin directly; bring the Auth password back in step (admin API).
    const sync = await db.auth.admin.updateUserById(cashier.id, { password: await deriveStaffPassword(cashier.id, cashier.pin) });
    expect(sync.error).toBeNull();
    const signed = await staffSignIn(cashier.id, cashier.pin);
    expect(signed.status).toBe(200);
    const newPin = await unusedPin();
    const changed = await callFn('change-own-pin', signed.json.accessToken, { newPin, terminalId: 'test' });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    expect(await storedPin(cashier.id)).toMatch(BCRYPT);
    expect((await staffSignIn(cashier.id, cashier.pin)).status).toBe(401);
    expect((await staffSignIn(cashier.id, newPin)).status).toBe(200);
    cashier.pin = newPin;

    const adminSession = await admin.client.auth.getSession();
    const resetPin = await unusedPin();
    const reset = await callFn('admin-reset-pin', adminSession.data.session.access_token, { targetStaffId: cashier.id, newPin: resetPin });
    expect(reset.status, JSON.stringify(reset.json)).toBe(200);
    expect(await storedPin(cashier.id)).toMatch(BCRYPT);
    expect((await staffSignIn(cashier.id, newPin)).status).toBe(401);
    expect((await staffSignIn(cashier.id, resetPin)).status).toBe(200);
    cashier.pin = resetPin;
  });

  it('verifies a wrong PIN against 30 active staff in under one second', async () => {
    for (let i = 0; i < 30; i++) {
      const { data, error } = await db.auth.admin.createUser({
        email: `${TAG}bulk${i}_${stamp}@test.local`, password: `Tp-${crypto.randomUUID()}`, email_confirm: true,
      });
      if (error || !data.user) throw new Error(`bulk user: ${error?.message}`);
      bulkIds.push(data.user.id);
      const { error: pErr } = await db.from('profiles').insert({
        id: data.user.id, name: `${TAG}bulk${i}`, email: data.user.email, role: 'cashier',
        pin: String(300000 + i * 7), is_active: true,
      });
      if (pErr) throw new Error(`bulk profile: ${pErr.message}`);
    }
    const wrong = await unusedPin();
    await manager.client.rpc('verify_staff_pin', { p_pin: wrong, p_staff_id: null }); // warm the plan
    await manager.client.rpc('verify_staff_pin', { p_pin: manager.pin, p_staff_id: manager.id });
    const t0 = performance.now();
    const { data, error } = await manager.client.rpc('verify_staff_pin', { p_pin: wrong, p_staff_id: null });
    const ms = performance.now() - t0;
    expect(error).toBeNull();
    expect(data.ok).toBe(false);
    console.info(`verify_staff_pin wrong PIN, all active staff: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(1000);
    await manager.client.rpc('verify_staff_pin', { p_pin: manager.pin, p_staff_id: manager.id });
  }, 120_000);
});
