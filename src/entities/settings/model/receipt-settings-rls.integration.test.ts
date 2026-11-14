/**
 * Integration tests: receipt_settings RLS role-scoped write isolation
 * (Phase 06, Plan 03 — SEC-02 / ROADMAP Success Criterion #4, D-05's
 * reinterpretation: a single store-wide singleton row, not per-terminal).
 *
 * Mirrors src/features/reopen-tab/model/reopen-tab-rpc.integration.test.ts's
 * structure (service-role seed/cleanup client + temp auth users +
 * signInWithPassword) because /settings is RBAC-gated admin-only at the
 * route layer — a Playwright browser test can never reach the write path as
 * a cashier to prove RLS blocks it (RESEARCH.md Pitfall 1). Only a
 * service-role Vitest integration test hitting Supabase directly can
 * exercise the RLS policy itself.
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: cd supermarket-pos && npx vitest run src/entities/settings/model/receipt-settings-rls.integration.test.ts
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ── Env guards ────────────────────────────────────────────────────────────────

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !anonKey || !serviceKey;

// receipt_settings is a true DB-enforced singleton (20260819000004): the
// `id` column defaults to this sentinel and the INSERT policy's WITH CHECK
// pins to it, so any row-seeding in these tests must use an explicit
// non-sentinel id to avoid colliding with the app's real singleton row.
const SENTINEL_ID = '00000000-0000-0000-0000-000000000001';

/** Supabase query builders are thenable but don't expose `.catch()` as an
 * own method — wrap in a real Promise so cleanup calls can swallow errors. */
async function safe(p: PromiseLike<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // best-effort cleanup — ignore
  }
}

describe.skipIf(skip)('receipt_settings RLS (integration)', () => {
  // receipt_settings is not yet in generated Supabase types — scoped `any`,
  // per CLAUDE.md's "Missing generated types workaround" (mirrors
  // useReceiptSettings()/useMutationUpdateReceiptSettings() in queries.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(url!, serviceKey!) as any;

  let managerId: string;
  let managerEmail: string;
  let managerPassword: string;
  let cashierId: string;
  let cashierEmail: string;
  let cashierPassword: string;

  const cleanupRowIds: string[] = [];

  async function createAuthStaff(role: 'manager' | 'cashier'): Promise<{
    id: string;
    email: string;
    password: string;
  }> {
    const email = `__receipt_settings_rls_${role}_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@test.local`;
    const password = 'TestReceiptSettingsRls123!';
    const { data: authUser, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !authUser.user) throw new Error(`createAuthStaff(${role}): ${createErr?.message}`);
    const id = authUser.user.id as string;

    const { error: profileErr } = await db.from('profiles').upsert({
      id,
      name: `__receipt_settings_rls_test_${role}__`,
      email,
      role,
      pin: role === 'manager' ? '999905' : '999906',
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
    const manager = await createAuthStaff('manager');
    managerId = manager.id;
    managerEmail = manager.email;
    managerPassword = manager.password;

    const cashier = await createAuthStaff('cashier');
    cashierId = cashier.id;
    cashierEmail = cashier.email;
    cashierPassword = cashier.password;
  });

  afterAll(async () => {
    if (managerId) {
      await safe(db.from('profiles').delete().eq('id', managerId));
      await safe(db.auth.admin.deleteUser(managerId));
    }
    if (cashierId) {
      await safe(db.from('profiles').delete().eq('id', cashierId));
      await safe(db.auth.admin.deleteUser(cashierId));
    }
  });

  afterEach(async () => {
    while (cleanupRowIds.length > 0) {
      const id = cleanupRowIds.pop();
      if (id) await safe(db.from('receipt_settings').delete().eq('id', id));
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let managerClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cashierClient: any;

  beforeEach(async () => {
    managerClient = await signInClient(managerEmail, managerPassword);
    cashierClient = await signInClient(cashierEmail, cashierPassword);
  });

  afterEach(async () => {
    await managerClient?.auth.signOut().catch(() => undefined);
    await cashierClient?.auth.signOut().catch(() => undefined);
  });

  it('cashier SELECT succeeds — receipt_settings_select_authenticated grants read to every authenticated role', async () => {
    const { error } = await cashierClient.from('receipt_settings').select('*');
    expect(error).toBeNull();
  });

  it('cashier INSERT is rejected by RLS', async () => {
    const { error, data } = await cashierClient
      .from('receipt_settings')
      .insert({ paper_width_chars: 40 })
      .select('id')
      .single();
    expect(error).not.toBeNull();
    if (data?.id) cleanupRowIds.push(data.id as string); // shouldn't happen, but never leak if RLS regresses
  });

  it('cashier UPDATE is rejected by RLS, and no row is actually changed', async () => {
    // Seed a fresh row via service-role (bypasses RLS) with an explicit
    // non-sentinel id — never touch the app's real singleton row, and the
    // default id now resolves to the sentinel which already has a row.
    const { data: seeded, error: seedErr } = await db
      .from('receipt_settings')
      .insert({ id: crypto.randomUUID(), paper_width_chars: 32 })
      .select('id, paper_width_chars')
      .single();
    if (seedErr || !seeded) throw new Error(`seed failed: ${seedErr?.message ?? 'no row'}`);
    cleanupRowIds.push(seeded.id as string);

    // PostgREST returns a *successful* empty response (not an error) for an
    // UPDATE that RLS silently narrows to 0 matched rows — chain
    // .select().single() so 0 affected rows surfaces as PGRST116 ("no rows"),
    // the only way to observe the RLS rejection from the client.
    const { error } = await cashierClient
      .from('receipt_settings')
      .update({ paper_width_chars: 40 })
      .eq('id', seeded.id)
      .select()
      .single();
    expect(error).not.toBeNull();

    const { data: after } = await db
      .from('receipt_settings')
      .select('paper_width_chars')
      .eq('id', seeded.id)
      .single();
    expect(after?.paper_width_chars).toBe(32);
  });

  it('manager INSERT of a second row is rejected — by RLS id-pin for a non-sentinel id, and by the unique constraint for the sentinel id', async () => {
    const { error: nonSentinelErr } = await managerClient
      .from('receipt_settings')
      .insert({ id: crypto.randomUUID(), paper_width_chars: 40 })
      .select('id')
      .single();
    expect(nonSentinelErr).not.toBeNull();

    // Default id resolves to the sentinel, which already holds the app's
    // real singleton row — proves the singleton invariant is DB-enforced,
    // not merely a client-side convention.
    const { error: sentinelErr } = await managerClient
      .from('receipt_settings')
      .insert({ paper_width_chars: 40 })
      .select('id')
      .single();
    expect(sentinelErr).not.toBeNull();
  });

  it('manager can UPDATE and DELETE the singleton row — both succeed, and the row is restored afterward', async () => {
    const { data: before, error: beforeErr } = await db
      .from('receipt_settings')
      .select('*')
      .eq('id', SENTINEL_ID)
      .single();
    if (beforeErr || !before) throw new Error(`precondition failed: singleton row missing (${beforeErr?.message ?? ''})`);

    try {
      const { error: updateErr } = await managerClient
        .from('receipt_settings')
        .update({ paper_width_chars: 48 })
        .eq('id', SENTINEL_ID);
      expect(updateErr).toBeNull();

      const { data: afterUpdate } = await db
        .from('receipt_settings')
        .select('paper_width_chars')
        .eq('id', SENTINEL_ID)
        .single();
      expect(afterUpdate?.paper_width_chars).toBe(48);

      const { error: deleteErr } = await managerClient.from('receipt_settings').delete().eq('id', SENTINEL_ID);
      expect(deleteErr).toBeNull();

      const { data: afterDelete } = await db.from('receipt_settings').select('id').eq('id', SENTINEL_ID).maybeSingle();
      expect(afterDelete).toBeNull();
    } finally {
      // Restore via service role (bypasses RLS) — manager INSERT of the
      // sentinel id is now only reachable when no row currently holds it.
      await safe(db.from('receipt_settings').upsert(before));
    }
  });
});
