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
  // persistSession:false: the shared default storage key would otherwise hand the signed-in
  // manager's session to the service client, which loses its INSERT right once audit_logs is locked down.
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const anonClient = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;

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

/**
 * two-mode Plan 02c, Task 1: audit_logs is closed to client INSERTs, record_audit
 * refuses the server-only `offline_sale.` namespace and the pre-02c write-off
 * shapes for a signed-in caller, and `resolve_offline_sale` follows `adjust_inventory`.
 * Target: dev2 only (127.0.0.1:56321).
 */
describe.skipIf(skip)('audit_logs insert lock-down and resolve_offline_sale matrix (02c Task 1)', () => {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } }) as any;
  const stamp = String(Date.now());
  const tag = '__audit_lockdown_test__';
  const roles = ['cashier', 'manager', 'admin'] as const;
  const users: Record<string, { id: string; client: any }> = {};

  beforeAll(async () => {
    expect(new URL(url!).host).toBe('127.0.0.1:56321');
    for (const role of roles) {
      const email = `${tag}${role}_${stamp}@test.local`;
      const password = `Pw-${stamp}-${role}-Xx9`;
      const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw new Error(`create ${role}: ${error?.message}`);
      const id = data.user.id as string;
      const { error: pErr } = await db
        .from('profiles')
        .upsert({ id, name: `${tag}${role}`, email, role, pin: String(500000 + Math.floor(Math.random() * 99999)), is_active: true });
      if (pErr) throw new Error(`profile ${role}: ${pErr.message}`);
      const client = createClient(url!, anonKey!, { auth: { persistSession: false } }) as any;
      const { error: sErr } = await client.auth.signInWithPassword({ email, password });
      if (sErr) throw new Error(`sign in ${role}: ${sErr.message}`);
      users[role] = { id, client };
    }
  });

  afterAll(async () => {
    // Only this suite's own rows (every one carries one of its users as actor); never by action name on shared dev2.
    await db.from('audit_logs').delete().in('actor_id', Object.values(users).map((u) => u.id));
    for (const u of Object.values(users)) {
      await db.from('profiles').delete().eq('id', u.id);
      await db.auth.admin.deleteUser(u.id);
    }
  });

  const rowsFor = async (action: string): Promise<unknown[]> => {
    const { data, error } = await db.from('audit_logs').select('id').eq('action', action).in('actor_id', Object.values(users).map((u) => u.id));
    expect(error).toBeNull();
    return data as unknown[];
  };

  it('INSERT on audit_logs is denied for a signed-in cashier, manager and admin', async () => {
    for (const role of roles) {
      const user = users[role]!;
      const action = (`__forged_${role}_${stamp}__`);
      const { error } = await user.client
        .from('audit_logs')
        .insert({ actor_id: users['admin']!.id, action, entity_type: 'test', source: 'rpc' });
      expect(error, `${role} insert`).not.toBeNull();
      expect(error.code, `${role} insert code`).toBe('42501');
      expect(await rowsFor(action), `${role} row`).toHaveLength(0);
    }
  });

  it('record_audit still writes for a signed-in caller, as that caller', async () => {
    const action = (`__plain_${stamp}__`);
    const { data, error } = await users['cashier']!.client.rpc('record_audit', { p_action: action, p_entity_type: 'test' });
    expect(error).toBeNull();
    expect(typeof data).toBe('string');
    const { data: row } = await db.from('audit_logs').select('actor_id').eq('id', data).single();
    expect(row.actor_id).toBe(users['cashier']!.id);
  });

  it('record_audit refuses an offline_sale.* action from a signed-in caller', async () => {
    for (const name of ['written_off', 'linked', 'rering_approved', 'escalated']) {
      const action = (`offline_sale.${name}`);
      const before = (await rowsFor(action)).length;
      const { data, error } = await users['manager']!.client.rpc('record_audit', { p_action: action, p_entity_type: 'offline_sale' });
      expect(error).toBeNull();
      expect(data).toBeNull();
      expect(await rowsFor(action)).toHaveLength(before);
    }
  });

  it('record_audit refuses the pre-02c write-off and already-recorded shapes and still accepts rering and confirmed_after_retry', async () => {
    const resolved = ('offline_sale_resolved');
    const entity = `${tag}${stamp}`;
    const count = async (resolution: string | null): Promise<number> => {
      const { data } = await db.from('audit_logs').select('after').eq('action', resolved).eq('entity_type', entity);
      return (data as { after: { resolution?: string } | null }[]).filter((r) => (r.after?.resolution ?? null) === resolution).length;
    };
    const call = (action: string, after: unknown) =>
      users['cashier']!.client.rpc('record_audit', { p_action: action, p_entity_type: entity, p_after: after });
    for (const after of [{ resolution: 'written_off' }, { resolution: 'already_recorded' }, {}, null]) {
      const { data, error } = await call(resolved, after);
      expect(error).toBeNull();
      expect(data, JSON.stringify(after)).toBeNull();
    }
    expect(await count('written_off')).toBe(0);
    expect(await count('already_recorded')).toBe(0);
    expect(await count(null)).toBe(0);
    for (const resolution of ['rering', 'confirmed_after_retry']) {
      const { data, error } = await call(resolved, { resolution });
      expect(error).toBeNull();
      expect(typeof data, resolution).toBe('string');
      expect(await count(resolution)).toBe(1);
    }
    const { data: review } = await call('offline_sale_needs_review', { reason: 'x' });
    expect(typeof review).toBe('string');
  });

  it('a leading-space offline_sale action is refused', async () => {
    const { data, error } = await users['cashier']!.client.rpc('record_audit', { p_action: ' offline_sale.written_off', p_entity_type: 'offline_sale' });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('a capitalised offline_sale action is refused', async () => {
    const { data, error } = await users['cashier']!.client.rpc('record_audit', { p_action: 'Offline_sale.written_off', p_entity_type: 'offline_sale' });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('an underscore lookalike of a server action is refused', async () => {
    const { data, error } = await users['cashier']!.client.rpc('record_audit', { p_action: 'offline_sale_written_off', p_entity_type: 'offline_sale' });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('a lookalike with the reserved name inside it is refused', async () => {
    for (const action of ['x.offline_sale.written_off', 'staff.offline_sale_resolved', 'a_offlinesale']) {
      const { data, error } = await users['manager']!.client.rpc('record_audit', { p_action: action, p_entity_type: 'offline_sale' });
      expect(error).toBeNull();
      expect(data, action).toBeNull();
    }
    const { data: ok } = await users['manager']!.client.rpc('record_audit', { p_action: 'offline_sale_needs_review', p_entity_type: 'offline_sale', p_after: { reason: 'x' } });
    expect(typeof ok).toBe('string');
  });

  it('a trailing-space legacy write-off shape is refused', async () => {
    const { data, error } = await users['cashier']!.client.rpc('record_audit', {
      p_action: 'offline_sale_resolved ',
      p_entity_type: 'offline_sale',
      p_after: { resolution: 'written_off' },
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('a padded payload cannot carry an allowed resolution past the truncation', async () => {
    const entity = `${tag}pad_${stamp}`;
    const { data, error } = await users['cashier']!.client.rpc('record_audit', {
      p_action: 'offline_sale_resolved',
      p_entity_type: entity,
      p_after: { resolution: 'rering', pad: 'x'.repeat(70000) },
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('the three client rows are still accepted', async () => {
    const entity = `${tag}ok_${stamp}`;
    const call = (action: string, after: unknown) =>
      users['cashier']!.client.rpc('record_audit', { p_action: action, p_entity_type: entity, p_after: after });
    expect(typeof (await call('offline_sale_needs_review', { reason: 'x' })).data).toBe('string');
    expect(typeof (await call('offline_sale_resolved', { resolution: 'rering' })).data).toBe('string');
    expect(typeof (await call('offline_sale_resolved', { resolution: 'confirmed_after_retry' })).data).toBe('string');
  });

  it('the service role can still write an offline_sale.* action', async () => {
    const action = ('offline_sale.written_off');
    const { data, error } = await db.rpc('record_audit', { p_action: action, p_entity_type: 'offline_sale', p_user_id: users['admin']!.id });
    expect(error).toBeNull();
    expect(typeof data).toBe('string');
  });

  it('every role holding adjust_inventory holds resolve_offline_sale after the migration', async () => {
    const { data: held } = await db.from('role_permissions').select('role').eq('action', 'adjust_inventory');
    const { data: got } = await db.from('role_permissions').select('role').eq('action', 'resolve_offline_sale');
    const have = new Set((got as { role: string }[]).map((r) => r.role));
    const need = (held as { role: string }[]).map((r) => r.role);
    expect(need.length).toBeGreaterThan(0);
    for (const role of need) expect(have.has(role), role).toBe(true);
  });

  it('a role without adjust_inventory does not', async () => {
    const { data: held } = await db.from('role_permissions').select('role').eq('action', 'adjust_inventory');
    const { data: got } = await db.from('role_permissions').select('role').eq('action', 'resolve_offline_sale');
    expect((held as { role: string }[]).map((r) => r.role)).not.toContain('cashier');
    expect((got as { role: string }[]).map((r) => r.role)).not.toContain('cashier');
  });
});
