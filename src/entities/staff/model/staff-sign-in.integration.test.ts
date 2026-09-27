/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: staff-sign-in edge function (local stack, edge runtime running).
 *
 * Run: npx vitest run src/entities/staff/model/staff-sign-in.integration.test.ts --project integration
 * Note: the local Auth service allows 30 sign-ins per 5 minutes per address;
 * repeated runs inside that window can fail with UNAVAILABLE.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

const TAG = '__staff_sign_in_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));

describe.skipIf(skip)('staff-sign-in', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const staff = { id: '', email: `${TAG}${stamp}@test.local`, pin: randomPin() };
  const locked = { id: '', email: `${TAG}l_${stamp}@test.local`, pin: randomPin() };
  const parallel = { id: '', email: `${TAG}p_${stamp}@test.local`, pin: randomPin() };
  const addressChange = { id: '', email: `${TAG}ac_${stamp}@test.local`, pin: randomPin() };
  const unknownStaffId = crypto.randomUUID();

  async function call(body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}/functions/v1/staff-sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${anonKey}`, ...extraHeaders },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function makeStaff(s: { id: string; email: string; pin: string }): Promise<void> {
    // The Auth password equals the PIN, as create-staff sets it.
    const { data, error } = await db.auth.admin.createUser({ email: s.email, password: s.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    s.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({
      id: s.id, name: TAG, email: s.email, role: 'cashier', pin: s.pin, is_active: true,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
  }

  async function removeStaff(s: { id: string }): Promise<void> {
    if (!s.id) return;
    await db.from('pin_attempts').delete().like('attempt_key', `login:${s.id}%`);
    await db.from('profiles').delete().eq('id', s.id);
    await db.auth.admin.deleteUser(s.id);
  }

  beforeAll(async () => {
    await makeStaff(staff);
    await makeStaff(locked);
    await makeStaff(parallel);
    await makeStaff(addressChange);
  });

  afterAll(async () => {
    await removeStaff(staff);
    await removeStaff(locked);
    await removeStaff(parallel);
    await removeStaff(addressChange);
    await db.from('pin_attempts').delete().like('attempt_key', `login:${unknownStaffId}%`);
  });

  it('returns a working session for the right PIN', async () => {
    const { status, json } = await call({ staffId: staff.id, pin: staff.pin });
    expect(status).toBe(200);
    expect(json.mustChangePin).toBe(false);
    const client = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const { error } = await client.auth.setSession({ access_token: json.accessToken, refresh_token: json.refreshToken });
    expect(error).toBeNull();
    const { data } = await client.auth.getUser();
    expect(data.user?.id).toBe(staff.id);
  });

  it('refuses a wrong PIN and an unknown staff id the same way', async () => {
    const wrongPin = staff.pin === '123456' ? '654321' : '123456';
    const wrong = await call({ staffId: staff.id, pin: wrongPin });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toBe('INVALID_CREDENTIALS');
    const unknown = await call({ staffId: unknownStaffId, pin: wrongPin });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error).toBe('INVALID_CREDENTIALS');
    expect(JSON.stringify(wrong.json)).not.toContain('@');
  });

  it('rejects a malformed request', async () => {
    expect((await call({ staffId: 'nope', pin: '12' })).status).toBe(400);
    expect((await call({})).status).toBe(400);
  });

  it('locks sign-in after repeated wrong PINs, even for the right PIN', async () => {
    const wrongPin = locked.pin === '123456' ? '654321' : '123456';
    let last: any = null;
    for (let i = 0; i < 5; i++) last = await call({ staffId: locked.id, pin: wrongPin });
    expect(last.status).toBe(401);
    expect(last.json.retryAfter).toBeGreaterThan(0);

    const right = await call({ staffId: locked.id, pin: locked.pin });
    expect(right.status).toBe(429);
    expect(right.json.error).toBe('LOCKED');
    expect(right.json.retryAfter).toBeGreaterThan(0);

    // Another staff member is not affected.
    expect((await call({ staffId: staff.id, pin: staff.pin })).status).toBe(200);
  });

  it('locks the account even when the caller address changes', async () => {
    const wrongPin = addressChange.pin === '123456' ? '654321' : '123456';
    let last: any = null;
    for (let i = 0; i < 5; i++) {
      last = await call({ staffId: addressChange.id, pin: wrongPin }, { 'x-forwarded-for': `10.0.0.${i}` });
    }
    expect(last.status).toBe(401);
    expect(last.json.retryAfter).toBeGreaterThan(0);

    const right = await call(
      { staffId: addressChange.id, pin: addressChange.pin },
      { 'x-forwarded-for': '10.0.0.99' }
    );
    expect(right.status).toBe(429);
    expect(right.json.error).toBe('LOCKED');
  });

  // Locks the parallel staff member's key: placed last so no later test depends on it.
  it('keeps the attempt budget under parallel requests', async () => {
    const wrongPin = parallel.pin === '123456' ? '654321' : '123456';
    const results = await Promise.all(
      Array.from({ length: 12 }, () => call({ staffId: parallel.id, pin: wrongPin })),
    );
    const statuses = results.map((r) => r.status);
    for (const status of statuses) {
      expect([401, 429]).toContain(status);
    }
    const invalidCount = statuses.filter((s) => s === 401).length;
    const lockedCount = statuses.filter((s) => s === 429).length;
    expect(invalidCount).toBeGreaterThanOrEqual(1);
    expect(invalidCount).toBeLessThanOrEqual(5);
    expect(invalidCount + lockedCount).toBe(12);
  });
});
