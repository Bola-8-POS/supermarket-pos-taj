/* eslint-disable */
/**
 * Integration test: V4/T-21-02 RBAC guard on profiles.locale (Phase 21-02).
 *
 * Proves the server-side guard, not just client-side UI hiding:
 *   1. A bartender (no manage_staff) CANNOT write another staff member's
 *      profiles.locale via a direct UPDATE — RLS-filtered to 0 rows by the
 *      existing profiles_update_admin policy.
 *   2. A bartender CAN set only their OWN locale via the set_own_locale
 *      SECURITY DEFINER RPC (no target-id param).
 *   3. After that self-write, the bartender's role is UNCHANGED — no
 *      privilege-escalation surface (T-21-03).
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY, E2E_BARTENDER_NAME, E2E_BARTENDER_PIN.
 * Skips gracefully (does not fail) when any are absent.
 *
 * Uses an anon client + signInWithPassword (PIN doubles as the E2E account's
 * password, per this repo's convention) so auth.uid() is populated for the
 * bartender's session — a service-role client bypasses RLS entirely and
 * would not actually exercise the guard under test. The service-role client
 * is used only for setup/teardown (seeding a throwaway target profile) and
 * for verifying post-condition state.
 *
 * DEPENDENCY: requires supabase/migrations/20260718000000_profiles_locale.sql
 * (profiles.locale column + set_own_locale RPC) to be LIVE on the target
 * Supabase project (confirmed applied by 21-02 Task 1).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['VITE_SUPABASE_URL'];
const anonKey = process.env['VITE_SUPABASE_ANON_KEY'];
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const bartenderName = process.env['E2E_BARTENDER_NAME'];
const bartenderPin = process.env['E2E_BARTENDER_PIN'];

const hasEnv = Boolean(url && anonKey && serviceKey && bartenderName && bartenderPin);

describe.skipIf(!hasEnv)('profiles.locale RLS guard (V4/T-21-02)', () => {
  let svc: any;
  let bartenderClient: SupabaseClient;
  let bartenderId: string;
  let bartenderOriginalLocale: string;
  let bartenderOriginalRole: string;
  let otherStaffId: string;
  const otherStaffOriginalLocale = 'es-MX';

  beforeAll(async () => {
    svc = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: bartenderProfile, error: bartenderErr } = await svc
      .from('profiles')
      .select('id, email, locale, role')
      .eq('name', bartenderName)
      .single();
    if (bartenderErr || !bartenderProfile) {
      throw new Error(`bartender profile lookup failed: ${bartenderErr?.message ?? 'not found'}`);
    }
    bartenderId = bartenderProfile.id as string;
    bartenderOriginalLocale = (bartenderProfile.locale as string | null) ?? 'es-MX';
    bartenderOriginalRole = bartenderProfile.role as string;

    const anonClient = createClient(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authErr } = await anonClient.auth.signInWithPassword({
      email: bartenderProfile.email as string,
      password: bartenderPin!,
    });
    if (authErr || !authData.session) {
      throw new Error(`bartender sign-in failed: ${authErr?.message ?? 'no session'}`);
    }
    bartenderClient = createClient(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${authData.session.access_token}` } },
    });

    // Seed a throwaway "other staff" profile (service-role, bypasses RLS) so
    // the cross-user write test has a concrete target that is NOT the
    // authenticated bartender's own row and is never a shared E2E fixture.
    const testEmail = `__locale_rls_test_${String(Date.now())}@test.local`;
    const { data: authUser, error: createErr } = await svc.auth.admin.createUser({
      email: testEmail,
      password: 'TestLocaleRls123!',
      email_confirm: true,
    });
    if (createErr || !authUser?.user) {
      throw new Error(`test user create failed: ${createErr?.message}`);
    }
    otherStaffId = authUser.user.id as string;

    const { error: profileErr } = await svc.from('profiles').upsert({
      id: otherStaffId,
      name: '__locale_rls_test__',
      email: testEmail,
      role: 'cashier',
      pin: '999997',
      is_active: true,
      locale: otherStaffOriginalLocale,
    });
    if (profileErr) throw new Error(`profile upsert failed: ${profileErr.message}`);
  });

  afterAll(async () => {
    // Reset the bartender's own locale so this test is idempotent and does
    // not pollute the shared E2E account (Task 4 requirement).
    if (bartenderClient) {
      await bartenderClient.rpc('set_own_locale', { p_locale: bartenderOriginalLocale } as never);
      await bartenderClient.auth.signOut();
    }

    if (otherStaffId) {
      await svc.from('profiles').delete().eq('id', otherStaffId);
      await svc.auth.admin.deleteUser(otherStaffId);
    }
  });

  it('cross-user direct UPDATE is RLS-filtered to 0 rows (bartender cannot write another staff locale)', async () => {
    const { data, error } = await bartenderClient
      .from('profiles')
      .update({ locale: 'en-US' })
      .eq('id', otherStaffId)
      .select();

    // No manage_staff permission -> RLS filters the UPDATE to 0 affected
    // rows rather than raising a Postgres-level error; either denial shape
    // satisfies "denied" (matches the rls-denial.integration.test.ts
    // convention for append-only/admin-only policies in this repo).
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect((data ?? []) as unknown[]).toHaveLength(0);
    }

    const { data: after, error: afterErr } = await svc
      .from('profiles')
      .select('locale')
      .eq('id', otherStaffId)
      .single();
    expect(afterErr).toBeNull();
    expect((after as { locale: string } | null)?.locale).toBe(otherStaffOriginalLocale);
  });

  it('set_own_locale succeeds for the bartender own session and role is unchanged', async () => {
    const { data: rpcData, error: rpcErr } = await bartenderClient.rpc(
      'set_own_locale',
      { p_locale: 'en-US' } as never
    );
    expect(rpcErr).toBeNull();
    expect((rpcData as { ok?: boolean } | null)?.ok).toBe(true);

    const { data: after, error: afterErr } = await svc
      .from('profiles')
      .select('locale, role')
      .eq('id', bartenderId)
      .single();
    expect(afterErr).toBeNull();
    expect((after as { locale: string; role: string } | null)?.locale).toBe('en-US');
    expect((after as { locale: string; role: string } | null)?.role).toBe(bartenderOriginalRole);

    // Reset to original locale immediately so a failure in afterAll's own
    // cleanup does not leave the shared bartender account mutated.
    const { error: resetErr } = await bartenderClient.rpc('set_own_locale', {
      p_locale: bartenderOriginalLocale,
    } as never);
    expect(resetErr).toBeNull();
  });
});
