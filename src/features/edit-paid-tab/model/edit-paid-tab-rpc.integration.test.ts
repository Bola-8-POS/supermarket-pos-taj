/**
 * Integration tests: edit_paid_tab RPC (Phase 22, Plan 02 — SC-1/SC-2).
 *
 * Mirrors src/entities/payment/model/split-payment-rpc.integration.test.ts
 * (service-role seed/cleanup client) and
 * src/entities/audit-log/model/rls-denial.integration.test.ts (temp auth
 * users + signInWithPassword, since edit_paid_tab's AUTH_FORBIDDEN check is
 * `auth.uid()`-based and must see a real authenticated, non-service-role
 * JWT — a service-role call has auth.uid() = NULL and would always fail the
 * role check).
 *
 * Requires: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * Run: cd bar-pos && npx vitest run src/features/edit-paid-tab/model/edit-paid-tab-rpc.integration.test.ts
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

describe.skipIf(skip)('edit_paid_tab RPC (integration)', () => {
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
  // CR-01 fix regression: a dedicated product WITH a known `inventory` row
  // (the shared `productId` above is "any active product" and may not have
  // one), so inventory.quantity_on_hand deltas are deterministic.
  let inventoryProductId: string;

  const cleanupTabIds: string[] = [];
  const cleanupCajaEntryConcepts: string[] = [];

  // The PINs seeded by createAuthStaff below. The RPC authorizes off an
  // approval ticket (verify_staff_pin with p_required_action, run with the
  // caller's session), not the caller's own auth.uid() role.
  const randomPin = (): string => String(100000 + Math.floor(Math.random() * 900000));
  const managerPin = randomPin();
  const cashierPin = randomPin();

  /** A fresh single-use ticket for edit_paid_tab, issued to the manager's session. */
  async function approval(): Promise<string> {
    const { data, error } = await managerClient.rpc('verify_staff_pin', {
      p_pin: managerPin, p_staff_id: null, p_required_action: 'edit_paid_tab',
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
    const email = `__edit_paid_tab_${role}_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@test.local`;
    const password = 'TestEditPaidTab123!';
    const { data: authUser, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !authUser.user) throw new Error(`createAuthStaff(${role}): ${createErr?.message}`);
    const id = authUser.user.id as string;

    const { error: profileErr } = await db.from('profiles').upsert({
      id,
      name: `__edit_paid_tab_test_${role}__`,
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
  }

  /** Seeds a status='paid' tab (owned by the manager) with one order_item. */
  async function seedPaidTab(
    unitPrice: number,
    quantity = 1,
    productOverride?: string
  ): Promise<SeedTabResult> {
    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: `Edit Paid Tab Integration ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        staff_id: managerId,
        shift_id: managerShiftId,
        status: 'paid',
        closed_at: new Date().toISOString(),
      })
      .select('id, version')
      .single();
    if (tabErr || !tab) throw new Error(`seedPaidTab: tab insert failed: ${tabErr?.message ?? 'no row'}`);

    const { data: order, error: orderErr } = await db
      .from('orders')
      .insert({ tab_id: tab.id, staff_id: managerId, status: 'served' })
      .select('id')
      .single();
    if (orderErr || !order) throw new Error(`seedPaidTab: order insert failed: ${orderErr?.message ?? 'no row'}`);

    const { data: item, error: itemErr } = await db
      .from('order_items')
      .insert({
        order_id: order.id,
        product_id: productOverride ?? productId,
        quantity,
        unit_price: unitPrice,
      })
      .select('id')
      .single();
    if (itemErr || !item) throw new Error(`seedPaidTab: item insert failed: ${itemErr?.message ?? 'no row'}`);

    cleanupTabIds.push(tab.id as string);
    return { tabId: tab.id as string, orderItemId: item.id as string, version: tab.version as number };
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

    // CR-01 regression fixture: a fresh product + inventory row with a known
    // starting quantity_on_hand, so the RPC's inventory adjustment is testable
    // deterministically (not dependent on whatever stock an arbitrary existing
    // product happens to have).
    const { data: cat } = await db.from('categories').select('id').limit(1).single();
    if (!cat) throw new Error('no category found for inventory-product seeding');
    const { data: invProduct, error: invProductErr } = await db
      .from('products')
      .insert({
        name: `__edit_paid_tab_inventory_test_${String(Date.now())}__`,
        base_price: 10.0,
        category_id: cat.id,
        is_active: true,
      })
      .select('id')
      .single();
    if (invProductErr || !invProduct) throw new Error(`inventory product seed failed: ${invProductErr?.message}`);
    inventoryProductId = invProduct.id as string;

    const { error: invRowErr } = await db
      .from('inventory')
      .insert({ product_id: inventoryProductId, quantity_on_hand: 100 });
    if (invRowErr) throw new Error(`inventory row seed failed: ${invRowErr.message}`);

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
    if (inventoryProductId) {
      await safe(db.from('stock_movements').delete().eq('product_id', inventoryProductId));
      await safe(db.from('inventory').delete().eq('product_id', inventoryProductId));
      await safe(db.from('products').delete().eq('id', inventoryProductId));
    }
  });

  afterEach(async () => {
    while (cleanupTabIds.length > 0) {
      const tabId = cleanupTabIds.pop();
      if (tabId) await safe(db.from('tabs').delete().eq('id', tabId));
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

  it('SC-1 happy path: a whitelisted order_item patch bumps tabs.version and returns the new total', async () => {
    const seed = await seedPaidTab(10.0, 2); // 20.00 subtotal

    const { data, error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'update', quantity: 3 }],
      p_notes: null,
      p_reason: 'Integration test: quantity correction',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(data.newTotal).toBe(30.0);
    expect(data.delta).toBe(10.0);
    expect(data.cajaAdjustmentRecorded).toBe(true);

    const { data: entries } = await db
      .from('caja_entries')
      .select('concept')
      .eq('caja_session_id', cajaId)
      .ilike('concept', '%quantity correction%');
    for (const row of (entries ?? []) as { concept: string }[]) {
      cleanupCajaEntryConcepts.push(row.concept);
    }

    const { data: tab } = await db.from('tabs').select('version').eq('id', seed.tabId).single();
    expect(tab?.version).toBe(seed.version + 1);

    const { data: audit } = await db
      .from('audit_logs')
      .select('after')
      .eq('action', 'tab.edit_paid')
      .eq('entity_id', seed.tabId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(audit?.after.approved_by).toBe(managerId);
  });

  it('SC-1: STALE_VERSION is returned when p_expected_version does not match tabs.version', async () => {
    const seed = await seedPaidTab(10.0, 1);

    const { error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version + 99,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'update', notes: 'stale attempt' }],
      p_notes: null,
      p_reason: 'Integration test: stale version',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).not.toBeNull();
    expect((error.message as string)).toContain('STALE_VERSION');
  });

  it('SC-1: AUTH_FORBIDDEN is returned when the caller is not manager/admin role', async () => {
    const seed = await seedPaidTab(10.0, 1);

    const { data, error } = await bartenderClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'update', notes: 'unauthorized attempt' }],
      p_notes: null,
      p_reason: 'Integration test: forbidden caller',
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('AUTH_FORBIDDEN');
  });

  it('SC-5: TAB_NOT_EDITABLE is returned when the tab is status=open (a reopened sale, not paid/closed)', async () => {
    const seed = await seedPaidTab(10.0, 1);

    // Direct status flip to simulate a reopened sale. The bump_version_on_update
    // trigger (Phase 15) requires every tabs UPDATE to advance version by
    // exactly +1, so the reopened version becomes seed.version + 1.
    const reopenedVersion = seed.version + 1;
    const { error: updateErr } = await db
      .from('tabs')
      .update({ status: 'open', version: reopenedVersion, closed_at: null })
      .eq('id', seed.tabId);
    if (updateErr) throw new Error(`seed reopen: tabs status update failed: ${updateErr.message}`);

    const { data, error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: reopenedVersion,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'update', notes: 'attempt on reopened tab' }],
      p_notes: null,
      p_reason: 'Integration test: reopened tab',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(false);
    expect(data.code).toBe('TAB_NOT_EDITABLE');
  });

  it('SC-1: a non-whitelisted key in an order_item patch is ignored, not applied (payments untouched)', async () => {
    const seed = await seedPaidTab(10.0, 1); // 10.00 subtotal, no delta expected

    const { data, error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_order_item_patches: [
        { id: seed.orderItemId, op: 'update', notes: 'whitelist test', discount_amount: 999, product_id: '00000000-0000-0000-0000-000000000000' },
      ],
      p_notes: null,
      p_reason: 'Integration test: whitelist enforcement',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    // total unchanged (only `notes` was a valid whitelisted key here) -> no caja adjustment
    expect(data.delta).toBe(0);
    expect(data.cajaAdjustmentRecorded).toBe(false);

    const { data: item } = await db.from('order_items').select('notes, product_id, unit_price, quantity').eq('id', seed.orderItemId).single();
    expect(item?.notes).toBe('whitelist test');
    expect(item?.product_id).toBe(productId); // bogus product_id key was ignored (op='update' never reads product_id)

    const { data: payments } = await db.from('payments').select('id').eq('tab_id', seed.tabId);
    expect(payments ?? []).toHaveLength(0); // payments table never touched
  });

  it('SC-1: a total-changing edit with an open caja inserts exactly one offsetting caja_entries row', async () => {
    const seed = await seedPaidTab(20.0, 1); // 20.00 subtotal

    const { data, error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'update', unit_price: 15.0 }], // -5.00 delta
      p_notes: null,
      p_reason: 'Integration test: caja offset (price correction)',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    expect(data.delta).toBe(-5.0);
    expect(data.cajaAdjustmentRecorded).toBe(true);

    const { data: entries } = await db
      .from('caja_entries')
      .select('type, amount, concept')
      .eq('caja_session_id', cajaId)
      .ilike('concept', `%Integration test: caja offset%`);
    const rows = (entries ?? []) as { type: string; amount: number; concept: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('expense');
    expect(rows[0]?.amount).toBe(5.0);
    if (rows[0]) cleanupCajaEntryConcepts.push(rows[0].concept);
  });

  it('SC-2: a successful edit writes an audit_logs row (action=tab.edit_paid) with before/after diff and the reason', async () => {
    const seed = await seedPaidTab(10.0, 1);
    const reason = 'Integration test: audit diff verification';

    const { data, error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'update', unit_price: 12.0 }],
      p_notes: 'edited via integration test',
      p_reason: reason,
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    if (data.cajaAdjustmentRecorded) {
      const { data: entries } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%audit diff verification%');
      for (const row of (entries ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }
    }

    const { data: logRows } = await db
      .from('audit_logs')
      .select('action, entity_type, entity_id, before, after')
      .eq('entity_id', seed.tabId)
      .eq('action', 'tab.edit_paid')
      .order('created_at', { ascending: false })
      .limit(1);
    const rows = (logRows ?? []) as { action: string; entity_type: string; entity_id: string; before: unknown; after: Record<string, unknown> }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_type).toBe('tab');
    expect(rows[0]?.before).not.toBeNull();
    expect(rows[0]?.after).not.toBeNull();
    expect(rows[0]?.after['reason']).toBe(reason);
  });

  // ── CR-01 regression: inventory.quantity_on_hand + stock_movements ────────
  // (22-REVIEW.md CR-01 — quantity/delete corrections previously never
  // touched inventory.quantity_on_hand or wrote a stock_movements row.)

  it('CR-01: a quantity-decreasing edit restores inventory.quantity_on_hand and writes a correction stock_movements row', async () => {
    const seed = await seedPaidTab(10.0, 3, inventoryProductId); // starts at qty=3

    const { data: before } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', inventoryProductId)
      .single();
    const startQty = before.quantity_on_hand as number;

    const { data, error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'update', quantity: 1 }], // 3 -> 1, restore 2
      p_notes: null,
      p_reason: 'Integration test: CR-01 quantity decrease restores inventory',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    if (data.cajaAdjustmentRecorded) {
      const { data: entries } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%CR-01 quantity decrease%');
      for (const row of (entries ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }
    }

    const { data: after } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', inventoryProductId)
      .single();
    expect(after?.quantity_on_hand).toBe(startQty + 2);

    const { data: movements } = await db
      .from('stock_movements')
      .select('quantity_delta, reason, ref_type, ref_id')
      .eq('ref_type', 'order_item')
      .eq('ref_id', seed.orderItemId);
    const movementRows = (movements ?? []) as { quantity_delta: number; reason: string }[];
    expect(movementRows).toHaveLength(1);
    expect(movementRows[0]?.reason).toBe('correction');
    expect(movementRows[0]?.quantity_delta).toBe(2);
  });

  it('CR-01: a quantity-increasing edit depletes inventory.quantity_on_hand and writes a correction stock_movements row', async () => {
    const seed = await seedPaidTab(10.0, 1, inventoryProductId); // starts at qty=1

    const { data: before } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', inventoryProductId)
      .single();
    const startQty = before.quantity_on_hand as number;

    const { data, error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'update', quantity: 4 }], // 1 -> 4, deplete 3 more
      p_notes: null,
      p_reason: 'Integration test: CR-01 quantity increase depletes inventory',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    if (data.cajaAdjustmentRecorded) {
      const { data: entries } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%CR-01 quantity increase%');
      for (const row of (entries ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }
    }

    const { data: after } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', inventoryProductId)
      .single();
    expect(after?.quantity_on_hand).toBe(startQty - 3);

    const { data: movements } = await db
      .from('stock_movements')
      .select('quantity_delta, reason')
      .eq('ref_type', 'order_item')
      .eq('ref_id', seed.orderItemId);
    const movementRows = (movements ?? []) as { quantity_delta: number; reason: string }[];
    expect(movementRows).toHaveLength(1);
    expect(movementRows[0]?.reason).toBe('correction');
    expect(movementRows[0]?.quantity_delta).toBe(-3);
  });

  it('CR-01: a soft-delete restores the item quantity to inventory.quantity_on_hand and writes a correction stock_movements row', async () => {
    const seed = await seedPaidTab(10.0, 5, inventoryProductId); // starts at qty=5

    const { data: before } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', inventoryProductId)
      .single();
    const startQty = before.quantity_on_hand as number;

    const { data, error } = await managerClient.rpc('edit_paid_tab', {
      p_tab_id: seed.tabId,
      p_expected_version: seed.version,
      p_order_item_patches: [{ id: seed.orderItemId, op: 'delete' }],
      p_notes: null,
      p_reason: 'Integration test: CR-01 soft-delete restores inventory',
      p_approval_id: await approval(),
      p_approver_id: managerId,
    });

    expect(error).toBeNull();
    expect(data.ok).toBe(true);
    if (data.cajaAdjustmentRecorded) {
      const { data: entries } = await db
        .from('caja_entries')
        .select('concept')
        .eq('caja_session_id', cajaId)
        .ilike('concept', '%CR-01 soft-delete%');
      for (const row of (entries ?? []) as { concept: string }[]) {
        cleanupCajaEntryConcepts.push(row.concept);
      }
    }

    const { data: item } = await db
      .from('order_items')
      .select('is_deleted, quantity')
      .eq('id', seed.orderItemId)
      .single();
    expect(item?.is_deleted).toBe(true);

    const { data: after } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', inventoryProductId)
      .single();
    expect(after?.quantity_on_hand).toBe(startQty + 5);

    const { data: movements } = await db
      .from('stock_movements')
      .select('quantity_delta, reason')
      .eq('ref_type', 'order_item')
      .eq('ref_id', seed.orderItemId);
    const movementRows = (movements ?? []) as { quantity_delta: number; reason: string }[];
    expect(movementRows).toHaveLength(1);
    expect(movementRows[0]?.reason).toBe('correction');
    expect(movementRows[0]?.quantity_delta).toBe(5);
  });

  // ── Final-review fix #2: terminal-anchored caja lookup ─────────────────────
  // (20260913000003_fix_reopen_edit_caja_terminal_scope.sql). edit_paid_tab
  // must derive its offsetting caja_entries session from the TAB's own
  // terminal (tabs.caja_session_id -> caja_sessions.terminal_id), not from
  // "whichever caja happens to be open".

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

    // caja_sessions carries the same bump_version_on_update trigger as tabs
    // (STALE_VERSION unless new.version = old.version + 1) — read the
    // current version first so a close actually lands, rather than silently
    // no-opping via safe()'s swallowed error.
    async function closeCaja(id: string): Promise<void> {
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

    async function anchorTabToCaja(tabId: string, currentVersion: number, cajaSessionId: string): Promise<number> {
      const newVersion = currentVersion + 1;
      const { error } = await db
        .from('tabs')
        .update({ caja_session_id: cajaSessionId, version: newVersion })
        .eq('id', tabId);
      if (error) throw new Error(`anchorTabToCaja: ${error.message}`);
      return newVersion;
    }

    it("positive: a tab anchored to terminal A has its total-changing edit recorded against terminal A's own open caja, even while terminal B is also open", async () => {
      const cajaA = await openTerminalCaja('A');
      const cajaB = await openTerminalCaja('B');
      try {
        const seed = await seedPaidTab(20.0, 1);
        const version = await anchorTabToCaja(seed.tabId, seed.version, cajaA);

        const { data, error } = await managerClient.rpc('edit_paid_tab', {
          p_tab_id: seed.tabId,
          p_expected_version: version,
          p_order_item_patches: [{ id: seed.orderItemId, op: 'update', unit_price: 15.0 }],
          p_notes: null,
          p_reason: 'Integration test: terminal-anchored edit',
          p_approval_id: await approval(),
          p_approver_id: managerId,
        });

        expect(error).toBeNull();
        expect(data.ok).toBe(true);
        expect(data.cajaAdjustmentRecorded).toBe(true);

        const { data: entriesA } = await db
          .from('caja_entries')
          .select('id, concept')
          .eq('caja_session_id', cajaA)
          .ilike('concept', '%terminal-anchored edit%');
        const rowsA = (entriesA ?? []) as { id: string; concept: string }[];
        expect(rowsA).toHaveLength(1);
        if (rowsA[0]) cleanupCajaEntryConcepts.push(rowsA[0].concept);

        const { data: entriesB } = await db
          .from('caja_entries')
          .select('id')
          .eq('caja_session_id', cajaB)
          .ilike('concept', '%terminal-anchored edit%');
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
        const seed = await seedPaidTab(20.0, 1);
        const version = await anchorTabToCaja(seed.tabId, seed.version, cajaC);
        await closeCaja(cajaC); // terminal C (the tab's own terminal) is now closed; D stays open

        const { error } = await managerClient.rpc('edit_paid_tab', {
          p_tab_id: seed.tabId,
          p_expected_version: version,
          p_order_item_patches: [{ id: seed.orderItemId, op: 'update', unit_price: 15.0 }],
          p_notes: null,
          p_reason: 'Integration test: terminal-anchored edit no open caja',
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
