import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test: append-only RLS on `audit_logs` (SC2, Phase 14-13).
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY
 * in the environment. Skips gracefully (does not fail) when live creds are absent.
 *
 * DEPENDENCY: this test requires the `audit_logs` table + RLS policies from
 * supabase/migrations/20260511000001_audit_logs_table.sql to be LIVE on the
 * target Supabase project (confirmed deployed by 14-01 / pushed by 14-14).
 *
 * Two clients:
 *   db         — service-role client: bypasses RLS for setup/teardown + seeding
 *                the target row to attempt tampering on.
 *   anonClient — authenticated (manager role) client: SELECT is permitted by
 *                `audit_logs_select_manager`, but there is no UPDATE/DELETE
 *                policy at all (append-only by omission) — both mutations
 *                must be denied for this authenticated, non-service-role user.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

describe.skipIf(skip)('audit_logs append-only RLS (SC2)', () => {
  const db = createClient(url!, serviceKey!) as any;
  const anonClient = createClient(url!, anonKey!) as any;

  let testUserId: string;
  let seededLogId: string;
  let seededAction: string;

  beforeAll(async () => {
    // 0. Create a temporary manager test user and sign in so anonClient carries
    //    an authenticated (non-service-role) JWT with role = manager.
    const testEmail = `__audit_rls_test_${String(Date.now())}@test.local`;
    const testPassword = 'TestAuditRls123!';

    const { data: authUser, error: createErr } = await db.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (createErr || !authUser.user) throw new Error(`test user create: ${createErr?.message}`);
    testUserId = authUser.user.id as string;

    const { error: profileErr } = await db.from('profiles').upsert({
      id: testUserId,
      name: '__audit_rls_test__',
      email: testEmail,
      role: 'manager',
      pin: '999998',
      is_active: true,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);

    const { error: signInErr } = await anonClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    if (signInErr) throw new Error(`sign in: ${signInErr.message}`);

    // 1. Seed a real audit_logs row (via service-role client, bypassing RLS)
    //    so there is a concrete id to attempt tampering on.
    seededAction = '__audit_rls_test_action__';
    const { data: seeded, error: seedErr } = await db
      .from('audit_logs')
      .insert({
        actor_id: testUserId,
        action: seededAction,
        entity_type: 'test_entity',
        entity_id: null,
        before: null,
        after: { note: 'seed for RLS denial test' },
        source: 'client',
      })
      .select('id')
      .single();
    if (seedErr || !seeded) throw new Error(`audit_logs seed insert: ${seedErr?.message}`);
    seededLogId = (seeded as { id: string }).id;
  });

  afterAll(async () => {
    await anonClient.auth.signOut();

    if (seededLogId) {
      await db.from('audit_logs').delete().eq('id', seededLogId);
    }
    if (testUserId) {
      await db.from('profiles').delete().eq('id', testUserId);
      await db.auth.admin.deleteUser(testUserId);
    }
  });

  it('SELECT is permitted for an authenticated manager (sanity check on the seeded row)', async () => {
    const { data, error } = await anonClient
      .from('audit_logs')
      .select('id, action')
      .eq('id', seededLogId)
      .single();

    expect(error).toBeNull();
    expect((data as { id: string; action: string } | null)?.action).toBe(seededAction);
  });

  it('UPDATE on audit_logs is denied for an authenticated manager (append-only RLS)', async () => {
    const { data, error } = await anonClient
      .from('audit_logs')
      .update({ action: 'tampered' })
      .eq('id', seededLogId)
      .select();

    // No UPDATE policy exists -> RLS silently filters the target row (0 rows
    // affected) rather than raising a Postgres-level error; either denial
    // shape (an error OR an empty affected-rows result) satisfies "denied".
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data as unknown[]).toHaveLength(0);
    }

    // The row must be unchanged regardless of which denial shape occurred.
    const { data: after, error: afterErr } = await db
      .from('audit_logs')
      .select('action')
      .eq('id', seededLogId)
      .single();
    expect(afterErr).toBeNull();
    expect((after as { action: string } | null)?.action).toBe(seededAction);
  });

  it('DELETE on audit_logs is denied for an authenticated manager (append-only RLS)', async () => {
    const { data, error } = await anonClient
      .from('audit_logs')
      .delete()
      .eq('id', seededLogId)
      .select();

    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data as unknown[]).toHaveLength(0);
    }

    // The row must still exist afterward (service-role read bypasses RLS).
    const { data: stillThere, error: existsErr } = await db
      .from('audit_logs')
      .select('id')
      .eq('id', seededLogId)
      .maybeSingle();
    expect(existsErr).toBeNull();
    expect((stillThere as { id: string } | null)?.id).toBe(seededLogId);
  });
});
