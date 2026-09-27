/* eslint-disable */
/**
 * Integration tests: process_refund RPC (Phase 6, Plan 10)
 *
 * Requires: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars
 * Auth tests also require: VITE_SUPABASE_ANON_KEY + E2E_MANAGER_NAME + E2E_MANAGER_PIN
 * Run: cd bar-pos && npx vitest run src/features/process-refund/process-refund-rpc.integration.test.ts
 *
 * process_refund uses auth.uid() in SECURITY DEFINER context, so calls must be made
 * with an authenticated user JWT (manager or admin role).
 * Service role client is used only for data seeding (bypasses RLS).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ── Env guards ────────────────────────────────────────────────────────────────

const hasEnv =
  typeof process.env['VITE_SUPABASE_URL'] === 'string' &&
  process.env['VITE_SUPABASE_URL'] !== '' &&
  typeof process.env['SUPABASE_SERVICE_ROLE_KEY'] === 'string' &&
  process.env['SUPABASE_SERVICE_ROLE_KEY'] !== '';

/** process_refund calls auth.uid() → needs signed-in manager JWT + anon key */
const hasAuthEnv =
  hasEnv &&
  typeof process.env['VITE_SUPABASE_ANON_KEY'] === 'string' &&
  process.env['VITE_SUPABASE_ANON_KEY'] !== '' &&
  typeof process.env['E2E_MANAGER_NAME'] === 'string' &&
  process.env['E2E_MANAGER_NAME'] !== '' &&
  typeof process.env['E2E_MANAGER_PIN'] === 'string' &&
  process.env['E2E_MANAGER_PIN'] !== '';

const hasBartenderEnv =
  hasAuthEnv &&
  typeof process.env['E2E_BARTENDER_NAME'] === 'string' &&
  process.env['E2E_BARTENDER_NAME'] !== '' &&
  typeof process.env['E2E_BARTENDER_PIN'] === 'string' &&
  process.env['E2E_BARTENDER_PIN'] !== '';

/** Live-DB test that calls process_refund as manager (needs auth env) */
const itAuth = hasAuthEnv ? it : it.skip;
/** Live-DB test that calls process_refund as bartender (needs bartender env) */
const itBartender = hasBartenderEnv ? it : it.skip;

// ── Client factories ──────────────────────────────────────────────────────────

/** Every account this file signed in as; their approval tickets are removed after each test. */
const signedInUserIds = new Set<string>();

function getServiceDb(): any {
  const url = process.env['VITE_SUPABASE_URL']!;
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Returns a Supabase client authenticated as the named staff member.
 * Looks up the profile email via service role, then signs in with anon key + PIN.
 * process_refund reads auth.uid() — this JWT must identify a manager/admin profile.
 */
async function getAuthClient(name: string, pin: string): Promise<SupabaseClient> {
  const url = process.env['VITE_SUPABASE_URL']!;
  const anonKey = process.env['VITE_SUPABASE_ANON_KEY']!;

  const svc = getServiceDb();
  const { data: profile, error: profileErr } = await svc
    .from('profiles')
    .select('email')
    .eq('name', name)
    .single();
  if (profileErr || !profile?.email) {
    throw new Error(
      `getAuthClient: profile "${name}" not found or missing email: ${profileErr?.message ?? 'no email'}`,
    );
  }

  const anonClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authErr } = await anonClient.auth.signInWithPassword({
    email: profile.email as string,
    password: pin, // PIN is used as password for E2E accounts
  });
  if (authErr || !authData.session) {
    throw new Error(`getAuthClient: sign-in failed for "${name}": ${authErr?.message ?? 'no session'}`);
  }
  signedInUserIds.add(authData.session.user.id);

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${authData.session.access_token}` } },
  });
}

/**
 * The manager prompt's server check, run with the caller's own session:
 * returns a fresh single-use approval ticket for process_refund.
 */
async function approval(client: SupabaseClient, pin: string): Promise<string> {
  const { data, error } = await (client as any).rpc('verify_staff_pin', {
    p_pin: pin, p_staff_id: null, p_required_action: 'process_refund',
  });
  if (error || !data?.ok || typeof data.approval_id !== 'string') {
    throw new Error(`approval: ${error?.message ?? JSON.stringify(data)}`);
  }
  return data.approval_id as string;
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function getStaffAndShift(svc: any): Promise<{ staffId: string; shiftId: string }> {
  const { data: staff } = await svc
    .from('profiles')
    .select('id')
    .in('role', ['manager', 'admin'])
    .limit(1)
    .single();
  if (!staff) throw new Error('getStaffAndShift: no manager/admin profile found');
  const staffId = staff.id as string;

  const { data: existing } = await svc
    .from('shifts')
    .select('id')
    .eq('staff_id', staffId)
    .is('clock_out', null)
    .limit(1)
    .maybeSingle();

  if (existing) return { staffId, shiftId: existing.id as string };

  const { data: newShift, error: shiftErr } = await svc
    .from('shifts')
    .insert({ staff_id: staffId, opening_cash: 0 })
    .select('id')
    .single();
  if (shiftErr || !newShift) throw new Error(`getStaffAndShift: shift create failed: ${shiftErr?.message ?? 'no row'}`);
  return { staffId, shiftId: newShift.id as string };
}

interface PaidTabSeed {
  tabId: string;
  paymentId: string;
  itemIds: string[];
  staffId: string;
}

/**
 * Seeds a closed (paid) tab with 5 order_items at $10 each = $50 total,
 * plus a corresponding payment row ($50, cash).
 */
async function seedPaidTabWithPayment(svc: any): Promise<PaidTabSeed> {
  const { staffId, shiftId } = await getStaffAndShift(svc);

  const { data: product } = await svc
    .from('products')
    .select('id, base_price')
    .eq('is_active', true)
    .limit(1)
    .single();
  if (!product) throw new Error('seedPaidTabWithPayment: no active product found');

  const { data: tab, error: tabErr } = await svc
    .from('tabs')
    .insert({
      customer_name: `Refund Integration Tab ${Date.now()}`,
      staff_id: staffId,
      shift_id: shiftId,
      status: 'paid',
      closed_at: new Date().toISOString(), // CHECK: paid requires closed_at IS NOT NULL
    })
    .select('id')
    .single();
  if (tabErr || !tab) throw new Error(`seedPaidTabWithPayment: tab insert failed: ${tabErr?.message ?? 'no row'}`);

  const { data: order, error: orderErr } = await svc
    .from('orders')
    .insert({ tab_id: tab.id, staff_id: staffId, status: 'served' })
    .select('id')
    .single();
  if (orderErr || !order) throw new Error(`seedPaidTabWithPayment: order insert failed: ${orderErr?.message ?? 'no row'}`);

  const { data: items, error: itemErr } = await svc
    .from('order_items')
    .insert(
      Array.from({ length: 5 }, () => ({
        order_id: order.id,
        product_id: product.id,
        quantity: 1,
        unit_price: 10.0, // 5 × $10 = $50 total
        modifier_price_delta: 0,
      })),
    )
    .select('id');
  if (itemErr || !items) throw new Error(`seedPaidTabWithPayment: items insert failed: ${itemErr?.message ?? 'no row'}`);

  const { data: payment, error: payErr } = await svc
    .from('payments')
    .insert({
      tab_id: tab.id,
      amount: 50.0,
      method: 'cash',
      processed_by: staffId,
      idempotency_key: `seed-refund-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    })
    .select('id')
    .single();
  if (payErr || !payment) throw new Error(`seedPaidTabWithPayment: payment insert failed: ${payErr?.message ?? 'no row'}`);

  return {
    tabId: tab.id as string,
    paymentId: payment.id as string,
    itemIds: (items as { id: string }[]).map((i) => i.id),
    staffId,
  };
}

/**
 * Cleanup: handles a tab + its refund rows.
 * Cleanup order matters — foreign key RESTRICT constraints require payments/refunds
 * to be removed before deleting their referenced rows.
 *
 * Sub-tab handling was removed (Phase 1, Plan 11, D-09): tabs.parent_tab_id and
 * split_tab_by_* no longer exist — split-tab is a removed feature, so tabs seeded
 * by this file never have sub-tabs to clean up.
 */
async function cleanup(svc: any, tabId: string): Promise<void> {
  // 1. Handle refunds linked to this tab's payments
  const { data: payments } = await svc
    .from('payments')
    .select('id')
    .eq('tab_id', tabId)
    .eq('is_refund', false);
  for (const p of (payments ?? []) as { id: string }[]) {
    const { data: refunds } = await svc
      .from('refunds')
      .select('id')
      .eq('original_payment_id', p.id);
    for (const r of (refunds ?? []) as { id: string }[]) {
      // Delete refund_items first (CASCADE would handle this, but be explicit)
      await svc.from('refund_items').delete().eq('refund_id', r.id);
      // Delete negative payment row that references this refund (RESTRICT on payments.refund_id)
      await svc.from('payments').delete().eq('refund_id', r.id);
    }
    await svc.from('refunds').delete().eq('original_payment_id', p.id);
  }

  // 2. Delete all remaining payments
  await svc.from('payments').delete().eq('tab_id', tabId);

  // 3. Delete the tab → cascade to its orders → cascade to order_items
  await svc.from('tabs').delete().eq('id', tabId);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('process_refund RPC (integration)', () => {
  let svc: any;
  let tabId: string;

  beforeEach(() => {
    svc = getServiceDb();
    tabId = '';
  });

  afterEach(async () => {
    if (tabId) {
      await cleanup(svc, tabId).catch(() => undefined);
    }
    if (signedInUserIds.size > 0) {
      const { error } = await svc.from('manager_approvals').delete().in('caller_id', [...signedInUserIds]);
      expect(error).toBeNull();
    }
  });

  itAuth('process_refund: inserts negative payment row and refund record', async () => {
    const { tabId: tid, paymentId, itemIds } = await seedPaidTabWithPayment(svc);
    tabId = tid;

    const managerClient = await getAuthClient(
      process.env['E2E_MANAGER_NAME']!,
      process.env['E2E_MANAGER_PIN']!,
    );

    // Refund 2 of 5 items with restock=true ($10 + $10 = $20)
    const refundItems = [
      { order_item_id: itemIds[0], qty: 1, amount: 10.0, restock: true },
      { order_item_id: itemIds[1], qty: 1, amount: 10.0, restock: true },
    ];

    const { data: refundId, error } = await (managerClient as any).rpc('process_refund', {
      p_original_payment_id: paymentId,
      p_items: refundItems,
      p_reason: 'wrong_order',
      p_approval_id: await approval(managerClient, process.env['E2E_MANAGER_PIN']!),
    });

    expect(error).toBeNull();
    expect(refundId).toBeTruthy();

    // Verify refund row
    const { data: refund } = await svc
      .from('refunds')
      .select('amount, reason, original_payment_id')
      .eq('id', refundId)
      .single();
    expect(Number(refund.amount)).toBe(20.0);
    expect(refund.reason).toBe('wrong_order');
    expect(refund.original_payment_id).toBe(paymentId);

    // Verify refund_items rows (2 items)
    const { data: rItems } = await svc
      .from('refund_items')
      .select('order_item_id, qty, amount, restock')
      .eq('refund_id', refundId);
    expect(rItems).toHaveLength(2);

    // Verify negative payment row (is_refund=true, amount=-20.00)
    const { data: negPayment } = await svc
      .from('payments')
      .select('amount, is_refund, refund_id')
      .eq('refund_id', refundId)
      .single();
    expect(Number(negPayment.amount)).toBe(-20.0);
    expect(negPayment.is_refund).toBe(true);
  });

  itAuth('process_refund: REFUND_EXCEEDS_ORIGINAL blocks over-refund', async () => {
    const { tabId: tid, paymentId, itemIds } = await seedPaidTabWithPayment(svc);
    tabId = tid;

    const managerClient = await getAuthClient(
      process.env['E2E_MANAGER_NAME']!,
      process.env['E2E_MANAGER_PIN']!,
    );

    // First refund: 1 item ($10) — succeeds; remaining refundable = $40
    const { error: firstErr } = await (managerClient as any).rpc('process_refund', {
      p_original_payment_id: paymentId,
      p_items: [{ order_item_id: itemIds[0], qty: 1, amount: 10.0, restock: false }],
      p_reason: 'billing_error',
      p_approval_id: await approval(managerClient, process.env['E2E_MANAGER_PIN']!),
    });
    expect(firstErr).toBeNull();

    // Second refund: all 5 items ($50) — total requested exceeds original ($50) - already refunded ($10) = $40
    // Requesting $50 when only $40 remains → REFUND_EXCEEDS_ORIGINAL
    const { error } = await (managerClient as any).rpc('process_refund', {
      p_original_payment_id: paymentId,
      p_items: itemIds.map((id: string) => ({ order_item_id: id, qty: 1, amount: 10.0, restock: false })),
      p_reason: 'billing_error',
      p_approval_id: await approval(managerClient, process.env['E2E_MANAGER_PIN']!),
    });

    expect(error).not.toBeNull();
    expect(error.message).toContain('REFUND_EXCEEDS_ORIGINAL');
  });

  itBartender('process_refund: AUTH_FORBIDDEN blocks bartender role', async () => {
    const { tabId: tid, paymentId, itemIds } = await seedPaidTabWithPayment(svc);
    tabId = tid;

    const bartenderClient = await getAuthClient(
      process.env['E2E_BARTENDER_NAME']!,
      process.env['E2E_BARTENDER_PIN']!,
    );

    const { data, error } = await (bartenderClient as any).rpc('process_refund', {
      p_original_payment_id: paymentId,
      p_items: [{ order_item_id: itemIds[0], qty: 1, amount: 10.0, restock: false }],
      p_reason: 'wrong_order',
      p_approval_id: null,
    });

    expect(error).toBeNull();
    expect(data).toBeNull();
    const { count } = await svc.from('refunds').select('id', { count: 'exact', head: true }).eq('original_payment_id', paymentId);
    expect(count).toBe(0);
  });

  itAuth(
    'process_refund: restock=true attempts deplete_for_order_item (stub graceful when Phase 4 absent)',
    async () => {
      const { tabId: tid, paymentId, itemIds } = await seedPaidTabWithPayment(svc);
      tabId = tid;

      const managerClient = await getAuthClient(
        process.env['E2E_MANAGER_NAME']!,
        process.env['E2E_MANAGER_PIN']!,
      );

      // restock=true should succeed even if deplete_for_order_item is not yet deployed (Phase 4 stub)
      const { data: refundId, error } = await (managerClient as any).rpc('process_refund', {
        p_original_payment_id: paymentId,
        p_items: [{ order_item_id: itemIds[0], qty: 1, amount: 10.0, restock: true }],
        p_reason: 'quality_issue',
        p_approval_id: await approval(managerClient, process.env['E2E_MANAGER_PIN']!),
      });

      expect(error).toBeNull();
      expect(refundId).toBeTruthy();
    },
  );
});

// ── Wave 3a: per-line refund bounds ─────────────────────────────────────────
//
// Self-contained fixtures (random PIN, staff-sign-in edge function) so these
// tests do not depend on the E2E_MANAGER_NAME/E2E_MANAGER_PIN preset-profile
// env vars the older tests above use.

const hasAnonEnv =
  hasEnv &&
  typeof process.env['VITE_SUPABASE_ANON_KEY'] === 'string' &&
  process.env['VITE_SUPABASE_ANON_KEY'] !== '';

const randomPin6 = (): string => String(100000 + Math.floor(Math.random() * 900000));

interface BoundsFixture {
  id: string;
  name: string;
  email: string;
  role: 'manager' | 'cashier';
  pin: string;
  client: any;
}

interface SingleLineSeed {
  tabId: string;
  paymentId: string;
  itemId: string;
}

async function seedSingleLineTab(
  svc: any,
  opts: {
    productId: string;
    quantity: number;
    unitPrice: number;
    modifierPriceDelta?: number;
    weightGrams?: number | null;
    paymentAmount: number;
    staffId: string;
    shiftId: string;
  },
): Promise<SingleLineSeed> {
  // Explicit staffId/shiftId, not getStaffAndShift(svc): that helper picks
  // *some* existing manager/admin profile (no ORDER BY), which can and did
  // pick up this describe block's own throwaway `manager` fixture — every
  // seeded tab/order/shift then belonged to it, and shifts is never cleaned
  // up by cleanup(), so the fixture profile outlived the test run and got
  // picked up again by unrelated tests' own "any manager" lookups.
  const { staffId, shiftId } = opts;
  const { data: tab, error: tabErr } = await svc
    .from('tabs')
    .insert({
      customer_name: `Refund Bounds Tab ${Date.now()}`,
      staff_id: staffId,
      shift_id: shiftId,
      status: 'paid',
      closed_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (tabErr || !tab) throw new Error(`seedSingleLineTab: tab insert failed: ${tabErr?.message ?? 'no row'}`);

  const { data: order, error: orderErr } = await svc
    .from('orders')
    .insert({ tab_id: tab.id, staff_id: staffId, status: 'served' })
    .select('id')
    .single();
  if (orderErr || !order) throw new Error(`seedSingleLineTab: order insert failed: ${orderErr?.message ?? 'no row'}`);

  const { data: item, error: itemErr } = await svc
    .from('order_items')
    .insert({
      order_id: order.id,
      product_id: opts.productId,
      quantity: opts.quantity,
      unit_price: opts.unitPrice,
      modifier_price_delta: opts.modifierPriceDelta ?? 0,
      weight_grams: opts.weightGrams ?? null,
    })
    .select('id')
    .single();
  if (itemErr || !item) throw new Error(`seedSingleLineTab: item insert failed: ${itemErr?.message ?? 'no row'}`);

  const { data: payment, error: payErr } = await svc
    .from('payments')
    .insert({
      tab_id: tab.id,
      amount: opts.paymentAmount,
      method: 'cash',
      processed_by: staffId,
      idempotency_key: `seed-refund-bounds-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    })
    .select('id')
    .single();
  if (payErr || !payment) throw new Error(`seedSingleLineTab: payment insert failed: ${payErr?.message ?? 'no row'}`);

  return { tabId: tab.id as string, paymentId: payment.id as string, itemId: item.id as string };
}

describe.skipIf(!hasAnonEnv)('process_refund — per-line bounds (wave 3a)', () => {
  const svc = getServiceDb();
  const stamp = String(Date.now());
  const anonUrl = process.env['VITE_SUPABASE_URL']!;
  const anonKey = process.env['VITE_SUPABASE_ANON_KEY']!;

  const manager: BoundsFixture = { id: '', name: `__refund_bounds_test__manager`, email: `__refund_bounds_test__m_${stamp}@test.local`, role: 'manager', pin: randomPin6(), client: null };
  const cashier: BoundsFixture = { id: '', name: `__refund_bounds_test__cashier`, email: `__refund_bounds_test__c_${stamp}@test.local`, role: 'cashier', pin: randomPin6(), client: null };
  const fixtures = [manager, cashier];
  const tabIds: string[] = [];
  let regularProductId = '';
  let weighedProductId = '';
  let boxProductId = '';
  let looseProductId = '';
  let shiftId = '';

  async function makeFixture(f: BoundsFixture): Promise<void> {
    const { data, error } = await svc.auth.admin.createUser({ email: f.email, password: f.pin, email_confirm: true });
    if (error || !data.user) throw new Error(`create user ${f.name}: ${error?.message}`);
    f.id = data.user.id as string;
    const { error: profileErr } = await svc
      .from('profiles')
      .upsert({ id: f.id, name: f.name, email: f.email, role: f.role, pin: f.pin, is_active: true });
    if (profileErr) throw new Error(`profile upsert ${f.name}: ${profileErr.message}`);
  }

  async function signIn(f: BoundsFixture): Promise<void> {
    const res = await fetch(`${anonUrl}/functions/v1/staff-sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ staffId: f.id, pin: f.pin }),
    });
    const json = await res.json().catch(() => null);
    if (res.status !== 200) throw new Error(`sign in ${f.name}: ${res.status} ${JSON.stringify(json)}`);
    const client = createClient(anonUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.setSession({ access_token: json.accessToken, refresh_token: json.refreshToken });
    if (error) throw new Error(`setSession ${f.name}: ${error.message}`);
    f.client = client;
  }

  async function removeFixture(f: BoundsFixture): Promise<void> {
    if (!f.id) return;
    // Defense against cross-test contamination: another integration test's
    // "pick any manager/admin" seed helper (getStaffAndShift, used by this
    // file's own older describe block above and by other files) can adopt
    // a still-live fixture profile as its staff member before this file's
    // own teardown runs, attaching stock_movements/shifts rows this block
    // never created. Delete by staff_id directly so a leftover reference
    // never blocks the profile delete below.
    const movDel = await svc.from('stock_movements').delete().eq('staff_id', f.id);
    expect(movDel.error).toBeNull();
    const shiftDel = await svc.from('shifts').delete().eq('staff_id', f.id);
    expect(shiftDel.error).toBeNull();
    // process_refund also writes the legacy singular audit_log table
    // (actor_id = the approver) for backward compat; cleanup() never
    // touches that table, so it is swept here too.
    const legacyAuditDel = await svc.from('audit_log').delete().eq('actor_id', f.id);
    expect(legacyAuditDel.error).toBeNull();
    await svc.from('pin_attempts').delete().like('attempt_key', `%${f.id}%`);
    const profDel = await svc.from('profiles').delete().eq('id', f.id).select('id');
    expect(profDel.error).toBeNull();
    expect(profDel.data).toHaveLength(1);
    const { error: authErr } = await svc.auth.admin.deleteUser(f.id);
    expect(authErr).toBeNull();
  }

  async function refund(item: SingleLineSeed, body: Array<{ order_item_id: string; qty: number; amount: number; restock: boolean }>) {
    return (cashier.client as any).rpc('process_refund', {
      p_original_payment_id: item.paymentId,
      p_items: body,
      p_reason: 'other',
      p_approval_id: await approval(cashier.client, manager.pin),
    });
  }

  beforeAll(async () => {
    for (const f of fixtures) await makeFixture(f);
    await signIn(manager);
    await signIn(cashier);

    // Dedicated tagged fixture products (not a shared live catalog product):
    // every test in this block that restocks leaves stock_movements rows and
    // moves quantity_on_hand, so both products are created here and deleted
    // in afterAll, same pattern as the codebase convention in
    // receive-po-shipment.integration.test.ts.
    const { data: category } = await svc.from('categories').select('id').limit(1).single();
    if (!category) throw new Error('no category found');

    const { data: regular, error: regularErr } = await svc
      .from('products')
      .insert({
        name: '__refund_bounds_test__regular_product',
        category_id: category.id,
        base_price: 10,
        sold_by_weight: false,
        is_active: true,
      })
      .select('id')
      .single();
    if (regularErr || !regular) throw new Error(`regular product insert: ${regularErr?.message}`);
    regularProductId = regular.id as string;
    const { error: regularInvErr } = await svc.from('inventory').insert({ product_id: regularProductId, quantity_on_hand: 5000 });
    if (regularInvErr) throw new Error(`regular product inventory insert: ${regularInvErr.message}`);

    const { data: weighed, error: weighedErr } = await svc
      .from('products')
      .insert({
        name: '__refund_bounds_test__weighed_product',
        category_id: category.id,
        base_price: 1,
        sold_by_weight: true,
        is_active: true,
      })
      .select('id')
      .single();
    if (weighedErr || !weighed) throw new Error(`weighed product insert: ${weighedErr?.message}`);
    weighedProductId = weighed.id as string;
    const { error: invErr } = await svc.from('inventory').insert({ product_id: weighedProductId, quantity_on_hand: 5000 });
    if (invErr) throw new Error(`weighed product inventory insert: ${invErr.message}`);

    // A box (parent) + loose (open-unit child) product pair, for the I-1
    // regression: a refund must restock a loose line by the refunded
    // quantity, not the whole order line.
    const { data: box, error: boxErr } = await svc
      .from('products')
      .insert({
        name: '__refund_bounds_test__box_product',
        category_id: category.id,
        base_price: 100,
        is_active: true,
        units_per_package: 20,
      })
      .select('id')
      .single();
    if (boxErr || !box) throw new Error(`box product insert: ${boxErr?.message}`);
    boxProductId = box.id as string;
    const { error: boxInvErr } = await svc.from('inventory').insert({ product_id: boxProductId, quantity_on_hand: 5 });
    if (boxInvErr) throw new Error(`box product inventory insert: ${boxInvErr.message}`);

    const { data: loose, error: looseErr } = await svc
      .from('products')
      .insert({
        name: '__refund_bounds_test__loose_product',
        category_id: category.id,
        base_price: 7.5,
        is_active: true,
        parent_product_id: boxProductId,
      })
      .select('id')
      .single();
    if (looseErr || !loose) throw new Error(`loose product insert: ${looseErr?.message}`);
    looseProductId = loose.id as string;

    // One shift, owned by this block's own cashier fixture — explicit, not
    // getStaffAndShift's "pick any manager/admin" (see removeFixture above).
    const { data: shift, error: shiftErr } = await svc
      .from('shifts')
      .insert({ staff_id: cashier.id, opening_cash: 0 })
      .select('id')
      .single();
    if (shiftErr || !shift) throw new Error(`shift insert: ${shiftErr?.message}`);
    shiftId = shift.id as string;
  });

  afterEach(async () => {
    for (const tabId of [...tabIds]) {
      await cleanup(svc, tabId).catch(() => undefined);
    }
    tabIds.length = 0;
    await svc.from('manager_approvals').delete().eq('caller_id', cashier.id);
  });

  afterAll(async () => {
    // Loose product first: open_units/audit_logs reference the box, and
    // the loose product's own stock_movements ('sale'/'correction' rows
    // from order_item insert/delete) are swept by product_id below too.
    if (boxProductId) {
      const { data: units } = await svc.from('open_units').select('id').eq('product_id', boxProductId);
      const unitIds = ((units as { id: string }[] | null) ?? []).map(u => u.id);
      if (unitIds.length > 0) {
        await svc.from('audit_logs').delete().in('entity_id', unitIds);
        const unitDel = await svc.from('open_units').delete().in('id', unitIds);
        expect(unitDel.error).toBeNull();
      }
    }
    for (const productId of [regularProductId, weighedProductId, looseProductId, boxProductId]) {
      if (!productId) continue;
      const movDel = await svc.from('stock_movements').delete().eq('product_id', productId);
      expect(movDel.error).toBeNull();
      const invDel = await svc.from('inventory').delete().eq('product_id', productId);
      expect(invDel.error).toBeNull();
      const prodDel = await svc.from('products').delete().eq('id', productId);
      expect(prodDel.error).toBeNull();
    }
    if (shiftId) {
      const shiftDel = await svc.from('shifts').delete().eq('id', shiftId);
      expect(shiftDel.error).toBeNull();
    }
    for (const f of fixtures) await removeFixture(f);
  });

  it('refuses a refund quantity above the line: REFUND_QTY_EXCEEDS_LINE', async () => {
    const item = await seedSingleLineTab(svc, { productId: regularProductId, quantity: 2, unitPrice: 10, paymentAmount: 20, staffId: cashier.id, shiftId });
    tabIds.push(item.tabId);
    const { data, error } = await refund(item, [{ order_item_id: item.itemId, qty: 3, amount: 10, restock: false }]);
    expect(data).toBeNull();
    expect(error?.message).toContain('REFUND_QTY_EXCEEDS_LINE');
  });

  it('refuses a second refund whose quantity sums above the line', async () => {
    // paymentAmount (1000) is far above the two $20 refunds combined so the
    // payment-level cap (REFUND_EXCEEDS_ORIGINAL) never fires — only the
    // per-line remaining-quantity cap (3 total, 2 already refunded) is
    // under test.
    const item = await seedSingleLineTab(svc, { productId: regularProductId, quantity: 3, unitPrice: 10, paymentAmount: 1000, staffId: cashier.id, shiftId });
    tabIds.push(item.tabId);
    const first = await refund(item, [{ order_item_id: item.itemId, qty: 2, amount: 20, restock: false }]);
    expect(first.error).toBeNull();
    const second = await refund(item, [{ order_item_id: item.itemId, qty: 2, amount: 20, restock: false }]);
    expect(second.data).toBeNull();
    expect(second.error?.message).toContain('REFUND_QTY_EXCEEDS_LINE');
  });

  it('refuses a refund amount above the line cap: REFUND_AMOUNT_EXCEEDS_LINE', async () => {
    // paymentAmount (100) is well above the requested 15 so the payment-level
    // cap (REFUND_EXCEEDS_ORIGINAL, checked first) does not fire — only the
    // per-line cap (unit_price * qty = 10) is under test here.
    const item = await seedSingleLineTab(svc, { productId: regularProductId, quantity: 1, unitPrice: 10, paymentAmount: 100, staffId: cashier.id, shiftId });
    tabIds.push(item.tabId);
    const { data, error } = await refund(item, [{ order_item_id: item.itemId, qty: 1, amount: 15, restock: false }]);
    expect(data).toBeNull();
    expect(error?.message).toContain('REFUND_AMOUNT_EXCEEDS_LINE');
  });

  it('refuses a non-positive refund quantity: REFUND_ITEM_INVALID', async () => {
    // amount is non-zero (not 0) so v_refund_total > 0 and the refunds row
    // itself can be inserted (refunds_amount_check) before the per-item loop
    // reaches the qty <= 0 guard and rolls the whole transaction back.
    const item = await seedSingleLineTab(svc, { productId: regularProductId, quantity: 1, unitPrice: 10, paymentAmount: 10, staffId: cashier.id, shiftId });
    tabIds.push(item.tabId);
    const { data, error } = await refund(item, [{ order_item_id: item.itemId, qty: 0, amount: 5, restock: false }]);
    expect(data).toBeNull();
    expect(error?.message).toContain('REFUND_ITEM_INVALID');
  });

  it('restocks a weighed line in grams, not units', async () => {
    const item = await seedSingleLineTab(svc, {
      productId: weighedProductId,
      quantity: 1,
      unitPrice: 20,
      weightGrams: 1500,
      paymentAmount: 20,
      staffId: cashier.id,
      shiftId,
    });
    tabIds.push(item.tabId);
    const { data: before } = await svc.from('inventory').select('quantity_on_hand').eq('product_id', weighedProductId).single();
    const beforeQty = Number(before?.quantity_on_hand ?? 0);

    const { data, error } = await refund(item, [{ order_item_id: item.itemId, qty: 1, amount: 20, restock: true }]);
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const { data: after } = await svc.from('inventory').select('quantity_on_hand').eq('product_id', weighedProductId).single();
    expect(Number(after.quantity_on_hand)).toBe(beforeQty + 1500);

    const { data: movement } = await svc
      .from('stock_movements')
      .select('quantity_delta')
      .eq('product_id', weighedProductId)
      .eq('reason', 'refund')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(Number(movement.quantity_delta)).toBe(1500);
  });

  it('restocks a loose (open-unit) line by the refunded quantity, not the whole line (I-1)', async () => {
    // An active open unit for the box, with room to credit back into.
    const { data: unit, error: unitErr } = await svc
      .from('open_units')
      .insert({ product_id: boxProductId, remaining_count: 5, status: 'active' })
      .select('id')
      .single();
    if (unitErr || !unit) throw new Error(`open unit insert: ${unitErr?.message}`);

    const item = await seedSingleLineTab(svc, {
      productId: looseProductId,
      quantity: 3,
      unitPrice: 7.5,
      paymentAmount: 22.5,
      staffId: cashier.id,
      shiftId,
    });
    tabIds.push(item.tabId);

    // Refund 1 of 3: before the fix this credited the whole line (3), not
    // the refunded quantity (1).
    const first = await refund(item, [{ order_item_id: item.itemId, qty: 1, amount: 7.5, restock: true }]);
    expect(first.error).toBeNull();
    const { data: afterFirst } = await svc.from('open_units').select('remaining_count').eq('id', unit.id).single();
    expect(afterFirst.remaining_count).toBe(6);

    // A second partial refund of 1: rises by 1 again, not a second full-line credit.
    const second = await refund(item, [{ order_item_id: item.itemId, qty: 1, amount: 7.5, restock: true }]);
    expect(second.error).toBeNull();
    const { data: afterSecond } = await svc.from('open_units').select('remaining_count').eq('id', unit.id).single();
    expect(afterSecond.remaining_count).toBe(7);
  });

  it('restocks a regular line by its quantity', async () => {
    const item = await seedSingleLineTab(svc, { productId: regularProductId, quantity: 2, unitPrice: 10, paymentAmount: 20, staffId: cashier.id, shiftId });
    tabIds.push(item.tabId);
    const { data: before } = await svc.from('inventory').select('quantity_on_hand').eq('product_id', regularProductId).single();
    const beforeQty = Number(before?.quantity_on_hand ?? 0);

    const { error } = await refund(item, [{ order_item_id: item.itemId, qty: 2, amount: 20, restock: true }]);
    expect(error).toBeNull();

    const { data: after } = await svc.from('inventory').select('quantity_on_hand').eq('product_id', regularProductId).single();
    expect(Number(after.quantity_on_hand)).toBe(beforeQty + 2);
  });

  it('the refund payment row names the caller as processed_by and the approver as approved_by', async () => {
    const item = await seedSingleLineTab(svc, { productId: regularProductId, quantity: 1, unitPrice: 10, paymentAmount: 10, staffId: cashier.id, shiftId });
    tabIds.push(item.tabId);
    const { data: refundId, error } = await refund(item, [{ order_item_id: item.itemId, qty: 1, amount: 10, restock: false }]);
    expect(error).toBeNull();

    const { data: negPayment } = await svc
      .from('payments')
      .select('processed_by, approved_by')
      .eq('refund_id', refundId)
      .single();
    expect(negPayment.processed_by).toBe(cashier.id);
    expect(negPayment.approved_by).toBe(manager.id);
  });

  // Not exercised: a sold_by_weight order_items row with quantity = 0.
  // order_items carries CHECK (quantity > 0) (quantity_positive, added in
  // 20260414000004_tabs_and_orders.sql, long before this wave) — no insert
  // or update, service role or not, can produce such a row, so the
  // restore_inventory_on_refund_item NULLIF(oi.quantity, 0) guard the plan
  // asks this case to pin can only ever protect a pre-constraint legacy row
  // today. See task-1-report.md for the full note.
});
