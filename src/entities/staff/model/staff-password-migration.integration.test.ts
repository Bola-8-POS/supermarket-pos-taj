/* eslint-disable */
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';
import { migrateStaffPasswords } from '../../../../scripts/lib/staff-password-migration';

/**
 * Integration test: the cutover migration re-derives a pre-change (raw-PIN) staff password.
 * Run: npx vitest run --project integration src/entities/staff/model/staff-password-migration.integration.test.ts
 * Signs in 6 times. The no-PIN and non-6-digit cases cannot be created here (profiles.pin is
 * NOT NULL with a 6-digit CHECK); the unit test covers them.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;
const TAG = '__pw_migration_test__';
const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));

describe.skipIf(skip)('staff password migration', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anon = () => createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
  const legacy = { id: '', email: `${TAG}${Date.now()}@test.local`, pin: randomPin() };
  // A soft-deleted profile: the migration must derive it too, not skip it.
  const removed = { id: '', email: `${TAG}d_${Date.now()}@test.local`, pin: randomPin() };

  async function makeLegacy(s: { id: string; email: string; pin: string }, extra: Record<string, unknown>): Promise<void> {
    // A pre-change account: the raw PIN is the Auth password.
    const { data, error } = await db.auth.admin.createUser({ email: s.email, password: s.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user: ${error?.message}`);
    s.id = data.user.id as string;
    const { error: profileErr } = await db.from('profiles').upsert({
      id: s.id, name: TAG, email: s.email, role: 'cashier', pin: s.pin, is_active: true, ...extra,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);
  }

  async function staffSignIn(pin: string): Promise<number> {
    const res = await fetch(`${url}/functions/v1/staff-sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey!, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ staffId: legacy.id, pin }),
    });
    return res.status;
  }

  beforeAll(async () => {
    await makeLegacy(legacy, {});
    await makeLegacy(removed, { deleted_at: new Date().toISOString() });
  });

  afterAll(async () => {
    for (const s of [legacy, removed]) {
      if (!s.id) continue;
      await db.from('pin_attempts').delete().like('attempt_key', `login:${s.id}%`);
      await db.from('profiles').delete().eq('id', s.id);
      await db.auth.admin.deleteUser(s.id);
    }
  });

  it('a dry run writes nothing', async () => {
    const result = await migrateStaffPasswords(db, { apply: false, onlyIds: [legacy.id] });
    expect(result).toMatchObject({ planned: 1, updated: 0, failed: [] });
    const raw = await anon().auth.signInWithPassword({ email: legacy.email, password: legacy.pin });
    expect(raw.error).toBeNull();
  });

  it('apply re-derives the password: the PIN works through staff-sign-in, the raw PIN no longer works on the Auth API', async () => {
    const result = await migrateStaffPasswords(db, { apply: true, onlyIds: [legacy.id] });
    expect(result).toMatchObject({ planned: 1, updated: 1, failed: [] });
    expect(await staffSignIn(legacy.pin)).toBe(200);
    const raw = await anon().auth.signInWithPassword({ email: legacy.email, password: legacy.pin });
    expect(raw.error?.status).toBe(400);
  });

  it('is idempotent', async () => {
    const result = await migrateStaffPasswords(db, { apply: true, onlyIds: [legacy.id] });
    expect(result).toMatchObject({ planned: 1, updated: 1, failed: [] });
    expect(await staffSignIn(legacy.pin)).toBe(200);
  });

  it('derives a deleted profile too: the raw PIN stops working for it', async () => {
    const result = await migrateStaffPasswords(db, { apply: true, onlyIds: [removed.id] });
    expect(result).toMatchObject({ planned: 1, updated: 1, scrambled: 0, failed: [], skipped: [] });
    const raw = await anon().auth.signInWithPassword({ email: removed.email, password: removed.pin });
    expect(raw.error?.status).toBe(400);
    const derived = await anon().auth.signInWithPassword({
      email: removed.email,
      password: await deriveStaffPassword(removed.id, removed.pin),
    });
    expect(derived.error).toBeNull();
  });
});
