/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: staff directory view and server-side PIN checks.
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
 * (local stack). Skips gracefully when they are absent.
 *
 * Run: npx vitest run src/entities/staff/model/pin-checks.integration.test.ts --project integration
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__pin_checks_test__';
const PASSWORD = `Tp-${crypto.randomUUID()}`;

interface TestUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'cashier';
  pin: string;
  client: any;
}

describe.skipIf(skip)('staff directory and PIN checks', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const signedOut = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const admin: TestUser = { id: '', name: `${TAG}admin`, email: `${TAG}a_${stamp}@test.local`, role: 'admin', pin: '', client: null };
  const cashier: TestUser = { id: '', name: `${TAG}cashier`, email: `${TAG}c_${stamp}@test.local`, role: 'cashier', pin: '', client: null };

  /** A six-digit value no active profile currently uses. */
  async function unusedPin(): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const candidate = String(100000 + Math.floor(Math.random() * 900000));
      const { count } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('pin', candidate);
      if (count === 0) return candidate;
    }
    throw new Error('no unused pin found');
  }

  async function makeUser(u: TestUser): Promise<void> {
    u.pin = await unusedPin();
    const { data, error } = await db.auth.admin.createUser({ email: u.email, password: PASSWORD, email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    u.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({
      id: u.id, name: u.name, email: u.email, role: u.role, pin: u.pin, is_active: true,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
    u.client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error: signInErr } = await u.client.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    if (signInErr) throw new Error(`sign in: ${signInErr.message}`);
  }

  async function removeUser(u: TestUser): Promise<void> {
    if (!u.id) return;
    await db.from('pin_attempts').delete().eq('attempt_key', `caller:${u.id}`);
    await db.from('profiles').delete().eq('id', u.id);
    await db.auth.admin.deleteUser(u.id);
  }

  beforeAll(async () => {
    await makeUser(admin);
    await makeUser(cashier);
  });

  afterAll(async () => {
    await removeUser(admin);
    await removeUser(cashier);
  });

  it('serves the staff list without credentials to a caller without a session', async () => {
    const { data, error } = await signedOut.from('staff_directory').select('*').eq('id', cashier.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0]).sort()).toEqual(['id', 'is_active', 'locale', 'must_change_pin', 'name', 'role']);
  });

  it('refuses writes through the staff list', async () => {
    for (const client of [signedOut, cashier.client, admin.client]) {
      const { error } = await client.from('staff_directory').update({ name: 'x' }).eq('id', cashier.id);
      expect(error?.code).toBe('42501');
    }
    const { data } = await db.from('profiles').select('name').eq('id', cashier.id).single();
    expect(data.name).toBe(cashier.name);
  });

  it('refuses a PIN check without a session', async () => {
    const { error } = await signedOut.rpc('verify_staff_pin', { p_pin: cashier.pin });
    expect(error?.code).toBe('42501');
  });

  it('matches a PIN to its staff member', async () => {
    const { data, error } = await admin.client.rpc('verify_staff_pin', { p_pin: cashier.pin });
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(data.matches).toEqual([{ id: cashier.id, name: cashier.name, role: 'cashier' }]);
  });

  it('rejects a valid PIN that belongs to someone else when a staff id is given', async () => {
    const { data, error } = await admin.client.rpc('verify_staff_pin', { p_pin: cashier.pin, p_staff_id: admin.id });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: false, code: 'INVALID_PIN' });
    await db.from('pin_attempts').delete().eq('attempt_key', `caller:${admin.id}`);
  });

  it('does not clear the counter on a match the caller may not use', async () => {
    const requiredAction = 'process_refund'; // cashier lacks it, admin/manager hold it
    const wrong = await unusedPin();
    for (let i = 0; i < 4; i++) {
      const { data, error } = await cashier.client.rpc('verify_staff_pin', { p_pin: wrong });
      expect(error).toBeNull();
      expect(data.ok).toBe(false);
    }

    const { data: ineligible, error: ineligibleErr } = await cashier.client.rpc('verify_staff_pin', {
      p_pin: cashier.pin,
      p_required_action: requiredAction,
    });
    expect(ineligibleErr).toBeNull();
    expect(ineligible).toMatchObject({ ok: false, code: 'INVALID_PIN' });

    const { data: locked, error: lockedErr } = await cashier.client.rpc('verify_staff_pin', { p_pin: wrong });
    expect(lockedErr).toBeNull();
    expect(locked).toMatchObject({ ok: false, code: 'LOCKED' });
    expect(locked.retry_after).toBeGreaterThan(0);

    await db.from('pin_attempts').delete().eq('attempt_key', `caller:${cashier.id}`);
  });

  it('clears the counter on a match the caller may use', async () => {
    const requiredAction = 'process_refund'; // admin holds it
    const wrong = await unusedPin();
    for (let i = 0; i < 4; i++) {
      const { data, error } = await admin.client.rpc('verify_staff_pin', { p_pin: wrong });
      expect(error).toBeNull();
      expect(data.ok).toBe(false);
    }

    const { data: eligible, error: eligibleErr } = await admin.client.rpc('verify_staff_pin', {
      p_pin: admin.pin,
      p_required_action: requiredAction,
    });
    expect(eligibleErr).toBeNull();
    expect(eligible.ok).toBe(true);
    expect(eligible.matches).toEqual([{ id: admin.id, name: admin.name, role: 'admin' }]);

    const { data: afterClear, error: afterClearErr } = await admin.client.rpc('verify_staff_pin', { p_pin: wrong });
    expect(afterClearErr).toBeNull();
    expect(afterClear).toMatchObject({ ok: false, code: 'INVALID_PIN' });

    await db.from('pin_attempts').delete().eq('attempt_key', `caller:${admin.id}`);
  });

  it('locks the caller after repeated wrong PINs, even for the right PIN', async () => {
    const wrong = await unusedPin();
    let last: any = null;
    for (let i = 0; i < 5; i++) {
      const { data, error } = await cashier.client.rpc('verify_staff_pin', { p_pin: wrong });
      expect(error).toBeNull();
      expect(data.ok).toBe(false);
      last = data;
    }
    expect(last.code).toBe('INVALID_PIN');
    expect(last.retry_after).toBeGreaterThan(0);

    const { data: locked } = await cashier.client.rpc('verify_staff_pin', { p_pin: cashier.pin });
    expect(locked).toMatchObject({ ok: false, code: 'LOCKED' });
    expect(locked.retry_after).toBeGreaterThan(0);

    // Another caller is not affected.
    const { data: other } = await admin.client.rpc('verify_staff_pin', { p_pin: admin.pin });
    expect(other.ok).toBe(true);
  });

  it('keeps the attempt helpers and table away from signed-in callers', async () => {
    const { error: recErr } = await admin.client.rpc('pin_attempt_record', { p_key: 'x', p_success: true });
    expect(recErr?.code).toBe('42501');
    const { error: waitErr } = await admin.client.rpc('pin_attempt_retry_after', { p_key: 'x' });
    expect(waitErr?.code).toBe('42501');
    const { error: beginErr } = await admin.client.rpc('pin_attempt_begin', { p_key: 'x' });
    expect(beginErr?.code).toBe('42501');
    const { error: tableErr } = await admin.client.from('pin_attempts').select('attempt_key').limit(1);
    expect(tableErr?.code).toBe('42501');
  });

  it('tells staff managers who already uses a PIN and refuses everyone else', async () => {
    const { data: holder, error } = await admin.client.rpc('staff_pin_holder', {
      p_pin: cashier.pin, p_exclude_staff_id: admin.id,
    });
    expect(error).toBeNull();
    expect(holder).toBe(cashier.name);

    const { data: self } = await admin.client.rpc('staff_pin_holder', {
      p_pin: cashier.pin, p_exclude_staff_id: cashier.id,
    });
    expect(self).toBeNull();

    const { error: forbidden } = await cashier.client.rpc('staff_pin_holder', { p_pin: admin.pin });
    expect(forbidden?.message).toContain('AUTH_FORBIDDEN');
  });

  // Locks the admin caller's key: placed last so no later test depends on it.
  it('keeps the attempt budget under parallel requests', async () => {
    const wrong = await unusedPin();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => admin.client.rpc('verify_staff_pin', { p_pin: wrong })),
    );

    for (const { error } of results) {
      expect(error).toBeNull();
    }

    const codes = results.map((r: any) => r.data.code);
    for (const code of codes) {
      expect(['INVALID_PIN', 'LOCKED']).toContain(code);
    }
    const invalidCount = codes.filter((c: string) => c === 'INVALID_PIN').length;
    const lockedCount = codes.filter((c: string) => c === 'LOCKED').length;
    expect(invalidCount).toBeGreaterThanOrEqual(1);
    expect(invalidCount).toBeLessThanOrEqual(5);
    expect(invalidCount + lockedCount).toBe(20);

    await db.from('pin_attempts').delete().eq('attempt_key', `caller:${admin.id}`);
  });
});
