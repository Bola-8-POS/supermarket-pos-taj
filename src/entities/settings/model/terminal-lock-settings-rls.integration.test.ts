/**
 * Integration tests: terminal_lock_settings RLS role-scoped write isolation
 * (Phase 21, Plan 01 — LCK-02, D-02).
 *
 * Mirrors receipt-settings-rls.integration.test.ts's structure (service-role
 * seed/cleanup client + temp auth users + signInWithPassword), extended to
 * also cover `admin` (the analog only needed manager/cashier) since D-02's
 * key deviation is that manage_settings is ADMIN-ONLY here -- manager writes
 * must be rejected too, unlike receipt_settings' manager+admin write policy.
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: cd supermarket-pos && npx vitest run src/entities/settings/model/terminal-lock-settings-rls.integration.test.ts
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ── Env guards ────────────────────────────────────────────────────────────────

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !anonKey || !serviceKey;

// terminal_lock_settings is keyed by terminal_id TEXT (D-02), not a UUID
// singleton -- use a distinct test-only terminal id so these tests never
// touch the app's real TERMINAL_ID row.
const TEST_TERMINAL_ID = '__test_terminal_lock_rls__';

/** Supabase query builders are thenable but don't expose `.catch()` as an
 * own method — wrap in a real Promise so cleanup calls can swallow errors. */
async function safe(p: PromiseLike<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // best-effort cleanup — ignore
  }
}

describe.skipIf(skip)('terminal_lock_settings RLS (integration)', () => {
  // terminal_lock_settings is not yet in generated Supabase types — scoped
  // `any`, per CLAUDE.md's "Missing generated types workaround" (mirrors
  // useTerminalLockSettings()/useMutationUpdateTerminalLockSettings() in
  // queries.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(url!, serviceKey!) as any;

  let cashierId: string;
  let cashierEmail: string;
  let cashierPassword: string;
  let managerId: string;
  let managerEmail: string;
  let managerPassword: string;
  let adminId: string;
  let adminEmail: string;
  let adminPassword: string;

  async function createAuthStaff(role: 'cashier' | 'manager' | 'admin'): Promise<{
    id: string;
    email: string;
    password: string;
  }> {
    const email = `__terminal_lock_rls_${role}_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@test.local`;
    const password = 'TestTerminalLockRls123!';
    const { data: authUser, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !authUser.user) throw new Error(`createAuthStaff(${role}): ${createErr?.message}`);
    const id = authUser.user.id as string;

    const pinByRole = { cashier: '999907', manager: '999908', admin: '999909' } as const;
    const { error: profileErr } = await db.from('profiles').upsert({
      id,
      name: `__terminal_lock_rls_test_${role}__`,
      email,
      role,
      pin: pinByRole[role],
      is_active: true,
    });
    if (profileErr) throw new Error(`createAuthStaff(${role}) profile upsert: ${profileErr.message}`);

    return { id, email, password };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function signInClient(email: string, password: string): Promise<any> {
    const client = createClient(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`signInClient: ${error.message}`);
    return client;
  }

  beforeAll(async () => {
    const cashier = await createAuthStaff('cashier');
    cashierId = cashier.id;
    cashierEmail = cashier.email;
    cashierPassword = cashier.password;

    const manager = await createAuthStaff('manager');
    managerId = manager.id;
    managerEmail = manager.email;
    managerPassword = manager.password;

    const admin = await createAuthStaff('admin');
    adminId = admin.id;
    adminEmail = admin.email;
    adminPassword = admin.password;
  });

  afterAll(async () => {
    for (const id of [cashierId, managerId, adminId]) {
      if (!id) continue;
      await safe(db.from('profiles').delete().eq('id', id));
      await safe(db.auth.admin.deleteUser(id));
    }
  });

  beforeEach(async () => {
    await safe(db.from('terminal_lock_settings').delete().eq('terminal_id', TEST_TERMINAL_ID));
    const { error: seedErr } = await db
      .from('terminal_lock_settings')
      .insert({ terminal_id: TEST_TERMINAL_ID, lock_timeout_seconds: 60 });
    if (seedErr) throw new Error(`seed failed: ${seedErr.message}`);
  });

  afterEach(async () => {
    await safe(db.from('terminal_lock_settings').delete().eq('terminal_id', TEST_TERMINAL_ID));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cashierClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let managerClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let adminClient: any;

  beforeEach(async () => {
    cashierClient = await signInClient(cashierEmail, cashierPassword);
    managerClient = await signInClient(managerEmail, managerPassword);
    adminClient = await signInClient(adminEmail, adminPassword);
  });

  afterEach(async () => {
    await cashierClient?.auth.signOut().catch(() => undefined);
    await managerClient?.auth.signOut().catch(() => undefined);
    await adminClient?.auth.signOut().catch(() => undefined);
  });

  it('cashier SELECT succeeds — select_authenticated grants read to every authenticated role', async () => {
    const { error } = await cashierClient
      .from('terminal_lock_settings')
      .select('*')
      .eq('terminal_id', TEST_TERMINAL_ID);
    expect(error).toBeNull();
  });

  it('cashier INSERT/UPDATE/DELETE is rejected by RLS', async () => {
    const otherTerminal = `${TEST_TERMINAL_ID}_cashier_insert`;
    const { error: insertErr } = await cashierClient
      .from('terminal_lock_settings')
      .insert({ terminal_id: otherTerminal, lock_timeout_seconds: 30 });
    expect(insertErr).not.toBeNull();
    await safe(db.from('terminal_lock_settings').delete().eq('terminal_id', otherTerminal));

    const { error: updateErr } = await cashierClient
      .from('terminal_lock_settings')
      .update({ lock_timeout_seconds: 30 })
      .eq('terminal_id', TEST_TERMINAL_ID)
      .select()
      .single();
    expect(updateErr).not.toBeNull();

    const { error: deleteErr } = await cashierClient
      .from('terminal_lock_settings')
      .delete()
      .eq('terminal_id', TEST_TERMINAL_ID)
      .select()
      .single();
    expect(deleteErr).not.toBeNull();

    const { data: after } = await db
      .from('terminal_lock_settings')
      .select('lock_timeout_seconds')
      .eq('terminal_id', TEST_TERMINAL_ID)
      .single();
    expect(after?.lock_timeout_seconds).toBe(60);
  });

  it('manager (not just cashier) INSERT/UPDATE/DELETE is ALSO rejected — D-02 deviation from receipt_settings', async () => {
    const otherTerminal = `${TEST_TERMINAL_ID}_manager_insert`;
    const { error: insertErr } = await managerClient
      .from('terminal_lock_settings')
      .insert({ terminal_id: otherTerminal, lock_timeout_seconds: 30 });
    expect(insertErr).not.toBeNull();
    await safe(db.from('terminal_lock_settings').delete().eq('terminal_id', otherTerminal));

    const { error: updateErr } = await managerClient
      .from('terminal_lock_settings')
      .update({ lock_timeout_seconds: 30 })
      .eq('terminal_id', TEST_TERMINAL_ID)
      .select()
      .single();
    expect(updateErr).not.toBeNull();

    const { error: deleteErr } = await managerClient
      .from('terminal_lock_settings')
      .delete()
      .eq('terminal_id', TEST_TERMINAL_ID)
      .select()
      .single();
    expect(deleteErr).not.toBeNull();

    const { data: after } = await db
      .from('terminal_lock_settings')
      .select('lock_timeout_seconds')
      .eq('terminal_id', TEST_TERMINAL_ID)
      .single();
    expect(after?.lock_timeout_seconds).toBe(60);
  });

  it('admin INSERT/UPDATE/DELETE all succeed', async () => {
    const otherTerminal = `${TEST_TERMINAL_ID}_admin_insert`;
    const { error: insertErr } = await adminClient
      .from('terminal_lock_settings')
      .insert({ terminal_id: otherTerminal, lock_timeout_seconds: 45 });
    expect(insertErr).toBeNull();

    const { error: updateErr } = await adminClient
      .from('terminal_lock_settings')
      .update({ lock_timeout_seconds: 30 })
      .eq('terminal_id', TEST_TERMINAL_ID);
    expect(updateErr).toBeNull();

    const { data: afterUpdate } = await db
      .from('terminal_lock_settings')
      .select('lock_timeout_seconds')
      .eq('terminal_id', TEST_TERMINAL_ID)
      .single();
    expect(afterUpdate?.lock_timeout_seconds).toBe(30);

    const { error: deleteErr } = await adminClient
      .from('terminal_lock_settings')
      .delete()
      .eq('terminal_id', otherTerminal);
    expect(deleteErr).toBeNull();

    const { data: afterDelete } = await db
      .from('terminal_lock_settings')
      .select('terminal_id')
      .eq('terminal_id', otherTerminal)
      .maybeSingle();
    expect(afterDelete).toBeNull();
  });
});
