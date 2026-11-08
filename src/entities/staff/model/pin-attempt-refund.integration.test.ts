/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Integration test: pin_attempt_refund gives back an attempt that pin_attempt_begin counted
 * (two-mode plan 01, Task 5A). Service-role RPC calls only: no Auth sign-ins, so it does not
 * spend the 30-per-5-minutes sign-in limit.
 * Run: npx vitest run --project integration src/entities/staff/model/pin-attempt-refund.integration.test.ts
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

describe.skipIf(skip)('pin_attempt_refund', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const keys: string[] = [];
  const newKey = (): string => {
    const key = `login:${crypto.randomUUID()}:refund-test`;
    keys.push(key);
    return key;
  };
  async function rpc(name: string, key: string): Promise<number> {
    const { data, error } = await db.rpc(name, { p_key: key });
    if (error) throw new Error(`${name}: ${error.message}`);
    return data as number;
  }
  async function row(key: string): Promise<{ failed_count: number; locked_until: string | null } | null> {
    const { data, error } = await db.from('pin_attempts').select('failed_count, locked_until').eq('attempt_key', key).maybeSingle();
    if (error) throw new Error(`pin_attempts read: ${error.message}`);
    return data;
  }

  afterAll(async () => {
    for (const key of keys) await db.from('pin_attempts').delete().eq('attempt_key', key);
  });

  it('gives back the attempt that triggered the lock', async () => {
    const key = newKey();
    for (let i = 0; i < 5; i++) expect(await rpc('pin_attempt_begin', key)).toBe(0);
    expect(await rpc('pin_attempt_retry_after', key)).toBeGreaterThan(0);

    expect(await rpc('pin_attempt_refund', key)).toBe(0);
    expect(await rpc('pin_attempt_retry_after', key)).toBe(0);
    expect((await row(key))?.failed_count).toBe(4);
    expect(await rpc('pin_attempt_begin', key)).toBe(0); // allowed again, not locked
  });

  it('keeps a shorter lock in force while the count stays at or above the threshold', async () => {
    const key = newKey();
    const { error } = await db.from('pin_attempts').upsert({
      attempt_key: key,
      failed_count: 6,
      locked_until: new Date(Date.now() + 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(error).toBeNull();
    const remaining = await rpc('pin_attempt_refund', key);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(30);
    expect((await row(key))?.failed_count).toBe(5);
  });

  it('removes the row when the count reaches zero, and ignores an unknown key', async () => {
    const key = newKey();
    expect(await rpc('pin_attempt_begin', key)).toBe(0);
    expect(await rpc('pin_attempt_refund', key)).toBe(0);
    expect(await row(key)).toBeNull();

    const unknown = newKey();
    expect(await rpc('pin_attempt_refund', unknown)).toBe(0);
    expect(await row(unknown)).toBeNull();
  });

  it('gives back one attempt per call; only a PIN reset (pin_attempt_clear_for_staff) clears the whole lock', async () => {
    // Interplay with Task 5: after 5 counted attempts the account is locked. A refund undoes only
    // the one attempt it is called for (the 503 branches), whereas clearing for the staff id removes
    // every key of that account, as admin-reset-pin does.
    const staffId = crypto.randomUUID();
    const key = `login:${staffId}`;
    keys.push(key);
    for (let i = 0; i < 5; i++) expect(await rpc('pin_attempt_begin', key)).toBe(0);
    expect(await rpc('pin_attempt_retry_after', key)).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) await rpc('pin_attempt_begin', key); // refused while locked: nothing more is counted
    expect((await row(key))?.failed_count).toBe(5);

    const { data: cleared, error } = await db.rpc('pin_attempt_clear_for_staff', { p_staff_id: staffId });
    expect(error).toBeNull();
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(await rpc('pin_attempt_retry_after', key)).toBe(0);
    expect(await row(key)).toBeNull();
  });

  it('is not callable by client roles', async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
    const { error } = await anon.rpc('pin_attempt_refund', { p_key: 'login:nobody' });
    expect(error?.code).toBe('42501');
  });
});
