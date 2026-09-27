/**
 * Integration tests: reopen_tab RPC (Phase 23, Plan 04 — live SC-1..SC-4 +
 * double-count regression).
 *
 * Mirrors src/features/edit-paid-tab/model/edit-paid-tab-rpc.integration.test.ts
 * (service-role seed/cleanup client + temp auth users + signInWithPassword,
 * since reopen_tab's AUTH_FORBIDDEN check is `auth.uid()`-based and must see
 * a real authenticated, non-service-role JWT).
 *
 * process_payment_atomic (used only by the double-count regression test) is
 * GRANTed to service_role only (mirrors split-payment-rpc.integration.test.ts
 * precedent — always called via the edge function's admin client in
 * production), so that one RPC call uses the service-role `db` client
 * directly instead of an authenticated client.
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: cd bar-pos && npx vitest run src/features/reopen-tab/model/reopen-tab-rpc.integration.test.ts
 */
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ── Env guards ────────────────────────────────────────────────────────────────

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !anonKey || !serviceKey;

/** Supabase query builders are thenable but don't expose `.catch()` as an
 * own method — wrap in a real Promise so cleanup calls can swallow errors. */
async function safe(p: PromiseLike<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    // best-effort cleanup — ignore
  }
}

function idKey(prefix: string): string {
  return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2, 9)}`;
}

describe.skipIf(skip)('reopen_tab RPC (integration)', () => {
  const db = createClient(url!, serviceKey!) as any;

  let managerId: string;
  let managerEmail: string;
  let managerPassword: string;
  let managerShiftId: string;
  let bartenderId: string;
  let bartenderEmail: string;
  let bartenderPassword: string;
  let productId: string;
  let cajaId: string;
  let cajaCreatedByTest = false;

  const cleanupTabIds: string[] = [];
  const cleanupCajaEntryConcepts: string[] = [];

  // The PINs seeded by createAuthStaff below. The RPC authorizes off an
  // approval ticket (verify_staff_pin with p_required_action, run with the
  // caller's session), not the caller's own auth.uid() role.
  const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));
  const managerPin = randomPin();
  const cashierPin = randomPin();

  /** A fresh single-use ticket for reopen_tab, issued to the manager's session. */
  async function approval(): Promise<string> {
    const { data, error } = await managerClient.rpc('verify_staff_pin', {
      p_pin: managerPin, p_staff_id: null, p_required_action: 'reopen_tab',
    });
    if (error || !data?.ok || typeof data.approval_id !== 'string') {
      throw new Error(`approval: ${error?.message ?? JSON.stringify(data)}`);
    }
    return data.approval_id as string;
  }

  async function createAuthStaff(role: 'manager' | 'cashier'): Promise<{
    id: string;
    email: string;
    password: string;
  }> {
    const email = `__reopen_tab_${role}_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@test.local`;
    const password = 'TestReopenTab123!';
    const { data: authUser, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !authUser.user) throw new Error(`createAuthStaff(${role}): ${createErr?.message}`);
    const id = authUser.user.id as string;

    const { error: profileErr } = await db.from('profiles').upsert({
      id,
      name: `__reopen_tab_test_${role}__`,
      email,
      role,
      pin: role === 'manager' ? managerPin : cashierPin,
      is_active: true,
    });
    if (profileErr) throw new Error(`createAuthStaff(${role}) profile upsert: ${profileErr.message}`);

    return { id, email, password };
  }

  async function signInClient(email: string, password: string): Promise<any> {
    const client = createClient(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`signInClient: ${error.message}`);
    return client;
  }

  interface SeedTabResult {
    tabId: string;
    orderItemId: string;
    version: number;
    subtotal: number;
    paymentId: string | null;
  }

  /** Seeds a closed/paid tab with one order_item, and (by default) a single
   * completed non-refund payment matching the item subtotal exactly — real
   * data for the void step and the double-count regression. */
  async function seedTab(opts: {
    unitPrice: number;
    quantity?: number;
    status?: 'closed' | 'paid';
    withPayment?: boolean;
  }): Promise<SeedTabResult> {
    const { unitPrice, quantity = 1, status = 'paid', withPayment = true } = opts;
    const subtotal = Math.round(unitPrice * quantity * 100) / 100;

    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: `Reopen Tab Integration ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        staff_id: managerId,
        shift_id: managerShiftId,
        status,
        closed_at: new Date().toISOString(),
      })
      .select('id, version')
      .single();
    if (tabErr || !tab) throw new Error(`seedTab: tab insert failed: ${tabErr?.message ?? 'no row'}`);

    const { data: order, error: orderErr } = await db
      .from('orders')
      .insert({ tab_id: tab.id, staff_id: managerId, status: 'served' })
      .select('id')
      .single();
    if (orderErr || !order) throw new Error(`seedTab: order insert failed: ${orderErr?.message ?? 'no row'}`);

    const { data: item, error: itemErr } = await db
      .from('order_items')
      .insert({ order_id: order.id, product_id: productId, quantity, unit_price: unitPrice })
      .select('id')
      .single();
    if (itemErr || !item) throw new Error(`seedTab: item insert failed: ${itemErr?.message ?? 'no row'}`);

    let paymentId: string | null = null;
    if (withPayment) {
      const { data: payment, error: payErr } = await db
        .from('payments')
        .insert({
          tab_id: tab.id,
          amount: subtotal,
          method: 'cash',
          processed_by: managerId,
          idempotency_key: idKey('__reopen_tab_seed_payment'),
          status: 'completed',
          is_refund: false,
        })
        .select('id')
        .single();
      if (payErr || !payment) throw new Error(`seedTab: payment insert failed: ${payErr?.message ?? 'no row'}`);
      paymentId = payment.id as string;
    }

    cleanupTabIds.push(tab.id as string);
    return {
      tabId: tab.id as string,
      orderItemId: item.id as string,
      version: tab.version as number,
      subtotal,
      paymentId,
    };
  }

  /** Directly sets fields on a seeded tab via the service-role client
   * (bypassing the RPC), bumping version in the SAME statement so the
   * bump_version_on_update trigger's `new.version = old.version + 1`
   * invariant is satisfied. Returns the new version to use as the RPC's
   * p_expected_version. */
  async function setTabState(tabId: string, patch: Record<string, unknown>): Promise<number> {
    const { data: current, error: readErr } = await db.from('tabs').select('version').eq('id', tabId).single();
    if (readErr || !current) throw new Error(`setTabState: read failed: ${readErr?.message ?? 'no row'}`);
    const newVersion = (current.version as number) + 1;
    const { error } = await db
      .from('tabs')
      .update({ ...patch, version: newVersion })
      .eq('id', tabId);
    if (error) throw new Error(`setTabState: update failed: ${error.message}`);
    return newVersion;
  }

  beforeAll(async () => {
    const manager = await createAuthStaff('manager');
    managerId = manager.id;
    managerEmail = manager.email;
    managerPassword = manager.password;

    const bartender = await createAuthStaff('cashier');
    bartenderId = bartender.id;
    bartenderEmail = bartender.email;
    bartenderPassword = bartender.password;

    const { data: shift, error: shiftErr } = await db
      .from('shifts')
      .insert({ staff_id: managerId, opening_cash: 0 })
      .select('id')
      .single();
    if (shiftErr || !shift) throw new Error(`shift seed failed: ${shiftErr?.message ?? 'no row'}`);
    managerShiftId = shift.id as string;

    const { data: product } = await db.from('products').select('id').eq('is_active', true).limit(1).single();
    if (!product) throw new Error('no active product found for seeding');
    productId = product.id as string;

    // Ensure an open caja session exists (caja_sessions_one_open allows at
    // most one open at a time) — reuse an existing one if present, otherwise
    // create one and close it again in afterAll.
    const { data: openCaja } = await db
      .from('caja_sessions')
      .select('id')
      .eq('status', 'open')
      .limit(1)
      .maybeSingle();
    if (openCaja) {
      cajaId = openCaja.id as string;
    } else {
      const { data: newCaja, error: cajaErr } = await db
        .from('caja_sessions')
        .insert({ opened_by: managerId, opening_cash: 0 })
        .select('id')
        .single();
      if (cajaErr || !newCaja) throw new Error(`caja seed failed: ${cajaErr?.message ?? 'no row'}`);
      cajaId = newCaja.id as string;
      cajaCreatedByTest = true;
    }
  });

  afterAll(async () => {
    if (cajaCreatedByTest && cajaId) {
      await safe(
        db
          .from('caja_sessions')
          .update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: managerId, closing_cash: 0 })
          .eq('id', cajaId)
      );
    }
    for (const concept of cleanupCajaEntryConcepts) {
      await safe(db.from('caja_entries').delete().eq('concept', concept));
    }
    await safe(db.from('audit_logs').delete().eq('actor_id', managerId));
    if (managerId) {
      // Every row that references the manager through a RESTRICT / NO ACTION
      // foreign key goes first (tickets, caja entries and sessions, stock
      // movements, shifts), each delete asserted, so the profile really goes.
      for (const [table, column] of [
        ['manager_approvals', 'caller_id'],
        ['caja_entries', 'staff_id'],
        ['stock_movements', 'staff_id'],
        ['caja_sessions', 'opened_by'],
        ['shifts', 'staff_id'],
      ] as const) {
        expect((await db.from(table).delete().eq(column, managerId)).error, `${table} cleanup`).toBeNull();
      }
      expect((await db.from('pin_attempts').delete().like('attempt_key', `%${managerId}%`)).error).toBeNull();
      expect((await db.from('profiles').delete().eq('id', managerId)).error).toBeNull();
      expect((await db.auth.admin.deleteUser(managerId)).error).toBeNull();
    }
    if (bartenderId) {
      expect((await db.from('pin_attempts').delete().like('attempt_key', `%${bartenderId}%`)).error).toBeNull();
      expect((await db.from('profiles').delete().eq('id', bartenderId)).error).toBeNull();
      expect((await db.auth.admin.deleteUser(bartenderId)).error).toBeNull();
    }
    const { count: left } = await db
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .in('id', [managerId, bartenderId].filter(Boolean));
    expect(left).toBe(0);
  });

  afterEach(async () => {
    // payments.tab_id -> tabs(id) is ON DELETE RESTRICT (payments_tab_id_key
    // UNIQUE was dropped in 20260424000005, the FK's RESTRICT was not) — any
    // payment row referencing a seeded tab must be deleted first or the tab
    // delete below silently no-ops inside safe().
    while (cleanupTabIds.length > 0) {
      const tabId = cleanupTabIds.pop();
      if (tabId) {
        await safe(db.from('payments').delete().eq('tab_id', tabId));
        await safe(db.from('tabs').delete().eq('id', tabId));
      }
    }
  });

  let managerClient: any;
  let bartenderClient: any;

  beforeEach(async () => {
    managerClient = await signInClient(managerEmail, managerPassword);
    bartenderClient = await signInClient(bartenderEmail, bartenderPassword);
  });

  afterEach(async () => {
    await managerClient?.auth.signOut().catch(() => undefined);
    await bartenderClient?.auth.signOut().catch(() => undefined);
  });

  // ── SC-1: happy path + version guard + auth gate ──────────────────────────

  it(
    'SC-1 happy path: reopening a closed/paid tab flips status to open, ' +
      'voids its completed payment(s) (status -> reopened_void), and bumps tabs.version',
    async () => {
      const seed = await seedTab({ unitPrice: 20.0 });

      const { data, error } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seed.tabId,
        p_expected_version: seed.version,
        p_reason: 'Integration test SC-1 happy path',
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });

      expect(error).toBeNull();
      expect(data.ok).toBe(true);
      expect(data.voidedPaymentTotal).toBe(20.0);

      const { data: entries } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%SC-1 happy path%');
      for (const row of (entries ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }

      const { data: tab } = await db
        .from('tabs')
        .select('status, closed_at, version, reopen_count')
        .eq('id', seed.tabId)
        .single();
      expect(tab?.status).toBe('open');
      expect(tab?.closed_at).toBeNull();
      expect(tab?.version).toBe(seed.version + 1);
      expect(tab?.reopen_count).toBe(1);

      const { data: payment } = await db.from('payments').select('status').eq('id', seed.paymentId).single();
      expect(payment?.status).toBe('reopened_void');

      const { data: audit } = await db
        .from('audit_logs')
        .select('after')
        .eq('action', 'tab.reopen')
        .eq('entity_id', seed.tabId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      expect(audit?.after.approved_by).toBe(managerId);
    }
  );

  it('SC-1: STALE_VERSION is returned when p_expected_version does not match tabs.version', async () => {
    const seed = await seedTab({ unitPrice: 10.0 });

    const { error } = await managerClient.rpc('reopen_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version + 99,
      p_reason: 'Integration test: stale version',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).not.toBeNull();
    expect(error.message as string).toContain('STALE_VERSION');
  });

  it('SC-1: AUTH_FORBIDDEN is returned when the caller is not manager/admin role (bartender)', async () => {
    const seed = await seedTab({ unitPrice: 10.0 });

    const { data, error } = await bartenderClient.rpc('reopen_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_reason: 'Integration test: forbidden caller',
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('AUTH_FORBIDDEN');
  });

  // ── SC-3: reopen cap + window ──────────────────────────────────────────────

  it(
    'SC-3: REOPEN_CAP_EXCEEDED is returned when the tab has already been reopened twice (reopen_count = 2), with no mutation',
    async () => {
      const seed = await seedTab({ unitPrice: 10.0 });
      const bumpedVersion = await setTabState(seed.tabId, { reopen_count: 2 });

      const { data, error } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seed.tabId,
        p_expected_version: bumpedVersion,
        p_reason: 'Integration test: cap exceeded',
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });

      expect(error).toBeNull();
      expect(data.ok).toBe(false);
      expect(data.code).toBe('REOPEN_CAP_EXCEEDED');

      const { data: tab } = await db
        .from('tabs')
        .select('status, version, reopen_count')
        .eq('id', seed.tabId)
        .single();
      expect(tab?.status).toBe('paid');
      expect(tab?.version).toBe(bumpedVersion);
      expect(tab?.reopen_count).toBe(2);
    }
  );

  it('SC-3: REOPEN_WINDOW_EXPIRED is returned when last_reopened_at is more than 24h ago', async () => {
    const seed = await seedTab({ unitPrice: 10.0 });
    const staleTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const bumpedVersion = await setTabState(seed.tabId, { last_reopened_at: staleTimestamp });

    const { data, error } = await managerClient.rpc('reopen_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: bumpedVersion,
      p_reason: 'Integration test: window expired',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('REOPEN_WINDOW_EXPIRED');
  });

  // ── D-05: split-payment sibling void ───────────────────────────────────────

  it(
    'D-05: reopening voids ALL non-refund completed payment siblings sharing tab_id, leaving is_refund=true rows untouched',
    async () => {
      const seed = await seedTab({ unitPrice: 20.0, withPayment: false });

      const { data: leg0 } = await db
        .from('payments')
        .insert({
          tab_id: seed.tabId,
          amount: 10.0,
          method: 'cash',
          processed_by: managerId,
          idempotency_key: idKey('__reopen_tab_leg0'),
          status: 'completed',
          is_refund: false,
        })
        .select('id')
        .single();
      const { data: leg1 } = await db
        .from('payments')
        .insert({
          tab_id: seed.tabId,
          amount: 10.0,
          method: 'card',
          processed_by: managerId,
          idempotency_key: idKey('__reopen_tab_leg1'),
          status: 'completed',
          is_refund: false,
        })
        .select('id')
        .single();
      const { data: refundRow } = await db
        .from('payments')
        .insert({
          tab_id: seed.tabId,
          amount: -5.0,
          method: 'cash',
          processed_by: managerId,
          idempotency_key: idKey('__reopen_tab_refund'),
          status: 'completed',
          is_refund: true,
        })
        .select('id')
        .single();

      const { data, error } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seed.tabId,
        p_expected_version: seed.version,
        p_reason: 'Integration test: split sibling void',
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });

      expect(error).toBeNull();
      expect(data.ok).toBe(true);
      expect(data.voidedPaymentTotal).toBe(20.0);

      const { data: entries } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%split sibling void%');
      for (const row of (entries ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }

      const { data: rows } = await db.from('payments').select('id, status, is_refund').eq('tab_id', seed.tabId);
      const byId = new Map(
        ((rows ?? []) as { id: string; status: string; is_refund: boolean }[]).map((r) => [r.id, r])
      );
      expect(byId.get(leg0.id as string)?.status).toBe('reopened_void');
      expect(byId.get(leg1.id as string)?.status).toBe('reopened_void');
      expect(byId.get(refundRow.id as string)?.status).toBe('completed');
      expect(byId.get(refundRow.id as string)?.is_refund).toBe(true);
    }
  );

  // ── SC-2: offsetting caja_entries row ──────────────────────────────────────

  it(
    'SC-2: a reopen with a non-zero voided total inserts exactly one expense caja_entries row; a payment-less closed tab (voided total 0) inserts none',
    async () => {
      const seedWithPayment = await seedTab({ unitPrice: 15.0 });
      const { data: dataA, error: errA } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seedWithPayment.tabId,
        p_expected_version: seedWithPayment.version,
        p_reason: 'Integration test: caja offset nonzero',
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });
      expect(errA).toBeNull();
      expect(dataA.ok).toBe(true);

      const { data: entries } = await db
        .from('caja_entries')
        .select('type, amount, concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%caja offset nonzero%');
      const rows = (entries ?? []) as { type: string; amount: number; concept: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe('expense');
      expect(rows[0]?.amount).toBe(15.0);
      if (rows[0]) cleanupCajaEntryConcepts.push(rows[0].concept);

      const seedNoPayment = await seedTab({ unitPrice: 10.0, status: 'closed', withPayment: false });
      const { data: dataB, error: errB } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seedNoPayment.tabId,
        p_expected_version: seedNoPayment.version,
        p_reason: 'Integration test: caja offset zero',
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });
      expect(errB).toBeNull();
      expect(dataB.ok).toBe(true);
      expect(dataB.voidedPaymentTotal).toBe(0);

      const { data: entriesB } = await db
        .from('caja_entries')
        .select('id')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%caja offset zero%');
      expect(entriesB ?? []).toHaveLength(0);
    }
  );

  // ── SC-4: audit trail ───────────────────────────────────────────────────────

  it(
    "SC-4: a successful reopen writes one audit_logs row (action='tab.reopen') with before/after diff and the reason",
    async () => {
      const seed = await seedTab({ unitPrice: 12.0 });
      const reason = 'Integration test: audit trail verification';

      const { data, error } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seed.tabId,
        p_expected_version: seed.version,
        p_reason: reason,
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });

      expect(error).toBeNull();
      expect(data.ok).toBe(true);

      const { data: entries } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%audit trail verification%');
      for (const row of (entries ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }

      const { data: logRows } = await db
        .from('audit_logs')
        .select('action, entity_type, entity_id, before, after')
        .eq('entity_id', seed.tabId)
        .eq('action', 'tab.reopen')
        .order('created_at', { ascending: false })
        .limit(1);
      const rows = (logRows ?? []) as {
        action: string;
        entity_type: string;
        entity_id: string;
        before: unknown;
        after: Record<string, unknown>;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entity_type).toBe('tab');
      expect(rows[0]?.before).not.toBeNull();
      expect(rows[0]?.after).not.toBeNull();
      expect(rows[0]?.after['reason']).toBe(reason);
    }
  );

  // ── Implicit regression (highest-risk gap) ──────────────────────────────────

  it(
    'CRITICAL: re-paying a reopened tab via process_payment_atomic does NOT double-count ' +
      'the reopened_void amount — a partial new payment smaller than the owed total does ' +
      'NOT close the tab, and it closes only once the new payment(s) alone cover the full owed total',
    async () => {
      const seed = await seedTab({ unitPrice: 20.0 }); // subtotal $20, one $20 completed (now-voided) payment

      const { data: reopenData, error: reopenErr } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seed.tabId,
        p_expected_version: seed.version,
        p_reason: 'Integration test: double-count regression',
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });
      expect(reopenErr).toBeNull();
      expect(reopenData.ok).toBe(true);

      const { data: entries } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%double-count regression%');
      for (const row of (entries ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }

      const { data: tabAfterReopen } = await db.from('tabs').select('status, version').eq('id', seed.tabId).single();
      expect(tabAfterReopen?.status).toBe('open');

      // Partial re-payment: $5 of the $20 owed. If the voided $20 payment were
      // still counted toward v_paid_line, 20 (stale) + 5 (new) = 25 >= 20 and
      // the tab would incorrectly close after this single small payment.
      const { data: partialRes, error: partialErr } = await db.rpc('process_payment_atomic', {
        p_tab_id: seed.tabId,
        p_staff_id: managerId,
        p_amount: 5.0,
        p_method: 'cash',
        p_idempotency_key: idKey('__reopen_tab_regression_partial'),
        p_tendered_amount: 5.0,
        p_expected_version: tabAfterReopen?.version as number,
      });
      expect(partialErr).toBeNull();
      expect(partialRes.ok).toBe(true);

      const { data: tabAfterPartial } = await db.from('tabs').select('status, version').eq('id', seed.tabId).single();
      expect(tabAfterPartial?.status).toBe('open'); // NOT closed yet — proves the voided amount is excluded

      // Cover the remaining $15 — the tab now closes exactly once, on the
      // NEW payments' combined total ($5 + $15 = $20), not on the voided
      // original payment plus a fraction of the new one.
      const { data: finalRes, error: finalErr } = await db.rpc('process_payment_atomic', {
        p_tab_id: seed.tabId,
        p_staff_id: managerId,
        p_amount: 15.0,
        p_method: 'cash',
        p_idempotency_key: idKey('__reopen_tab_regression_final'),
        p_tendered_amount: 15.0,
        p_expected_version: tabAfterPartial?.version as number,
      });
      expect(finalErr).toBeNull();
      expect(finalRes.ok).toBe(true);

      const { data: tabAfterFinal } = await db.from('tabs').select('status').eq('id', seed.tabId).single();
      expect(tabAfterFinal?.status).toBe('paid');
    }
  );

  // ── CR-01 regression: second reopen must not double-count the first ────────
  // reopen's already-voided total (23-REVIEW.md CR-01).

  it(
    'CR-01: reopening the SAME tab a second time (after a full repayment) reports ' +
      "voidedPaymentTotal and a caja expense equal to ONLY the second payment's amount, " +
      'not the sum of both the first and second voided payments',
    async () => {
      const seed = await seedTab({ unitPrice: 20.0 }); // payment A = $20, completed

      // Reopen #1: voids payment A ($20).
      const { data: reopen1, error: reopen1Err } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seed.tabId,
        p_expected_version: seed.version,
        p_reason: 'Integration test: CR-01 first reopen',
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });
      expect(reopen1Err).toBeNull();
      expect(reopen1.ok).toBe(true);
      expect(reopen1.voidedPaymentTotal).toBe(20.0);

      const { data: entries1 } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%CR-01 first reopen%');
      for (const row of (entries1 ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }

      const { data: tabAfterReopen1 } = await db
        .from('tabs')
        .select('version')
        .eq('id', seed.tabId)
        .single();

      // Re-pay in full: payment B = $20, completed. Tab closes again.
      const { data: payRes, error: payErr } = await db.rpc('process_payment_atomic', {
        p_tab_id: seed.tabId,
        p_staff_id: managerId,
        p_amount: 20.0,
        p_method: 'cash',
        p_idempotency_key: idKey('__reopen_tab_cr01_repay'),
        p_tendered_amount: 20.0,
        p_expected_version: tabAfterReopen1?.version as number,
      });
      expect(payErr).toBeNull();
      expect(payRes.ok).toBe(true);

      const { data: tabAfterRepay } = await db
        .from('tabs')
        .select('status, version')
        .eq('id', seed.tabId)
        .single();
      expect(tabAfterRepay?.status).toBe('paid');

      // Reopen #2: must void ONLY payment B ($20), not A + B ($40).
      const { data: reopen2, error: reopen2Err } = await managerClient.rpc('reopen_tab', {
        p_tab_id: seed.tabId,
        p_expected_version: tabAfterRepay?.version as number,
        p_reason: 'Integration test: CR-01 second reopen',
        p_approval_id: await approval(),
        p_approver_id: managerId,
      });
      expect(reopen2Err).toBeNull();
      expect(reopen2.ok).toBe(true);
      expect(reopen2.voidedPaymentTotal).toBe(20.0);

      const { data: entries2 } = await db
        .from('caja_entries')
        .select('type, amount, concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%CR-01 second reopen%');
      const rows2 = (entries2 ?? []) as { type: string; amount: number; concept: string }[];
      expect(rows2).toHaveLength(1);
      expect(rows2[0]?.type).toBe('expense');
      expect(rows2[0]?.amount).toBe(20.0);
      if (rows2[0]) cleanupCajaEntryConcepts.push(rows2[0].concept);

      const { data: tabAfterReopen2 } = await db
        .from('tabs')
        .select('status, reopen_count')
        .eq('id', seed.tabId)
        .single();
      expect(tabAfterReopen2?.status).toBe('open');
      expect(tabAfterReopen2?.reopen_count).toBe(2);
    }
  );

  // ── Final-review fix #2: terminal-anchored caja lookup ─────────────────────
  // (20260913000003_fix_reopen_edit_caja_terminal_scope.sql). reopen_tab must
  // derive its offsetting caja_entries session from the TAB's own terminal
  // (tabs.caja_session_id -> caja_sessions.terminal_id), not from "whichever
  // caja happens to be open" — otherwise a reversal for terminal A's tab
  // could silently land in terminal B's open caja.

  describe('terminal-anchored caja lookup', () => {
    async function openTerminalCaja(label: string): Promise<string> {
      const terminalId = `T${label}${String(Date.now())}${Math.random().toString(36).slice(2, 5)}`.slice(0, 32);
      const { data, error } = await db
        .from('caja_sessions')
        .insert({ opened_by: managerId, opening_cash: 0, terminal_id: terminalId })
        .select('id')
        .single();
      if (error || !data) throw new Error(`openTerminalCaja(${label}): ${error?.message ?? 'no row'}`);
      return data.id as string;
    }

    async function closeCaja(id: string): Promise<void> {
      // caja_sessions carries the same bump_version_on_update trigger as
      // tabs (STALE_VERSION unless new.version = old.version + 1) — read the
      // current version first so this close actually lands, rather than
      // silently no-opping via safe()'s swallowed error (which would leave
      // the negative test's "own terminal caja is closed" precondition
      // false and the test passing for the wrong reason).
      const { data } = await db.from('caja_sessions').select('version').eq('id', id).single();
      const version = ((data as { version?: number } | null)?.version ?? 0) + 1;
      await safe(
        db
          .from('caja_sessions')
          .update({
            status: 'closed',
            closed_at: new Date().toISOString(),
            closed_by: managerId,
            closing_cash: 0,
            version,
          })
          .eq('id', id)
      );
    }

    it('positive: a tab anchored to terminal A is reopened against terminal A\'s own open caja, even while terminal B is also open', async () => {
      const cajaA = await openTerminalCaja('A');
      const cajaB = await openTerminalCaja('B');
      try {
        const seed = await seedTab({ unitPrice: 20.0 });
        const bumpedVersion = await setTabState(seed.tabId, { caja_session_id: cajaA });

        const { data, error } = await managerClient.rpc('reopen_tab', {
          p_tab_id: seed.tabId,
          p_expected_version: bumpedVersion,
          p_reason: 'Integration test: terminal-anchored reopen',
          p_approval_id: await approval(),
          p_approver_id: managerId,
        });

        expect(error).toBeNull();
        expect(data.ok).toBe(true);

        const { data: entriesA } = await db
          .from('caja_entries')
          .select('id, concept')
          .eq('caja_session_id', cajaA)
          .ilike('concept', '%terminal-anchored reopen%');
        const rowsA = (entriesA ?? []) as { id: string; concept: string }[];
        expect(rowsA).toHaveLength(1);
        if (rowsA[0]) cleanupCajaEntryConcepts.push(rowsA[0].concept);

        const { data: entriesB } = await db
          .from('caja_entries')
          .select('id')
          .eq('caja_session_id', cajaB)
          .ilike('concept', '%terminal-anchored reopen%');
        expect(entriesB ?? []).toHaveLength(0);
      } finally {
        await closeCaja(cajaA);
        await closeCaja(cajaB);
      }
    });

    it("negative: NO_OPEN_CAJA (P0A02) is returned when the tab's own terminal caja is closed, even though another terminal's caja is open", async () => {
      const cajaC = await openTerminalCaja('C');
      const cajaD = await openTerminalCaja('D');
      try {
        const seed = await seedTab({ unitPrice: 20.0 });
        const bumpedVersion = await setTabState(seed.tabId, { caja_session_id: cajaC });
        await closeCaja(cajaC); // terminal C (the tab's own terminal) is now closed; D stays open

        const { error } = await managerClient.rpc('reopen_tab', {
          p_tab_id: seed.tabId,
          p_expected_version: bumpedVersion,
          p_reason: 'Integration test: terminal-anchored reopen no open caja',
          p_approval_id: await approval(),
          p_approver_id: managerId,
        });

        expect(error).not.toBeNull();
        expect(error.message as string).toContain('NO_OPEN_CAJA');
        expect(error.code).toBe('P0A02');
      } finally {
        await closeCaja(cajaD);
      }
    });
  });
});
