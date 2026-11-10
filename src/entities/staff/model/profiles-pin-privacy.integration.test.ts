/**
 * Release gate (cloud-offline-release T3b): no signed-in cashier or manager, and no anon caller, can read
 * profiles.pin -- through the table (named column and select *) or through the staff_directory view.
 * Needs local dev2 (VITE_SUPABASE_URL) + fixture PINs; skips when they are absent.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveStaffPassword } from '../../../../scripts/lib/staff-password';
import { FIXTURE_ACCOUNTS, fixturePin, haveFixturePins, type FixtureRole } from '../../../test/fixture-accounts';

const url = process.env['VITE_SUPABASE_URL'];
const anonKey = process.env['VITE_SUPABASE_ANON_KEY'];
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url ?? '');
const hasEnv = Boolean(url && anonKey && serviceKey) && isLoopback && haveFixturePins();

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

async function signedIn(role: FixtureRole): Promise<SupabaseClient> {
  const acct = FIXTURE_ACCOUNTS[role];
  const client = createClient(url!, anonKey!, opts);
  const { error } = await client.auth.signInWithPassword({
    email: acct.email,
    password: await deriveStaffPassword(acct.id, fixturePin(role)),
  });
  if (error) throw new Error(`${role} sign-in failed: ${error.message}`);
  return client;
}

describe.skipIf(!hasEnv)('profiles.pin is not readable by staff or anon', () => {
  const clients = new Map<string, SupabaseClient>();

  beforeAll(async () => {
    // Fixture passwords go stale when the pepper changes: reseed them via the admin API (never raw SQL).
    const admin = createClient(url!, serviceKey!, opts);
    for (const role of ['cashier', 'manager'] as const) {
      const acct = FIXTURE_ACCOUNTS[role];
      const { error } = await admin.auth.admin.updateUserById(acct.id, {
        password: await deriveStaffPassword(acct.id, fixturePin(role)),
      });
      if (error) throw new Error(`${role} password reseed failed: ${error.message}`);
    }
    clients.set('anon', createClient(url!, anonKey!, opts));
    clients.set('cashier', await signedIn('cashier'));
    clients.set('manager', await signedIn('manager'));
  });

  for (const who of ['anon', 'cashier', 'manager']) {
    it(`${who}: select pin from profiles is refused`, async () => {
      const { data, error } = await clients.get(who)!.from('profiles').select('pin').limit(1);
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it(`${who}: select * from profiles does not return a pin column`, async () => {
      const { data, error } = await clients.get(who)!.from('profiles').select('*').limit(1);
      // column grants make select * fail outright; if it ever succeeds it must not carry pin
      if (!error) for (const row of data) expect(Object.keys(row)).not.toContain('pin');
    });

    it(`${who}: staff_directory exposes no pin`, async () => {
      const named = await clients.get(who)!.from('staff_directory').select('pin').limit(1);
      expect(named.error).not.toBeNull();
      const all = await clients.get(who)!.from('staff_directory').select('*').limit(5);
      for (const row of all.data ?? []) expect(Object.keys(row)).not.toContain('pin');
    });
  }
});
