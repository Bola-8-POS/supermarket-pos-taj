/* eslint-disable */
// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

/**
 * Integration test: process_direct_sale_atomic's promotion/floor-guard
 * extension (Phase 27, Plan 01, Task 3).
 *
 * Calls the RPC directly via the service-role client (bypassing the edge
 * function) — process_direct_sale_atomic trusts p_staff_id directly rather
 * than auth.uid() (same as process_payment_atomic, mirrored from
 * bank-transfer-rpc.integration.test.ts), so a service-role client with an
 * explicit p_staff_id is sufficient; no JWT sign-in is needed for these
 * three scenarios.
 *
 * Proves the TS/plpgsql parity backstop truth: evaluateBestPromotion()'s
 * computed discount for a fixture input matches what the live RPC actually
 * wrote to order_items for the identical fixture.
 *
 * Run: npx vitest run src/entities/promotion/model/promotion-rpc.integration.test.ts
 */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Promotion } from '@shared/lib/domain';
import { testDb } from '@shared/lib/supabase-test-client';
import { evaluateBestPromotion } from './promotion-pricing';

const hasEnv =
  typeof process.env['VITE_SUPABASE_URL'] === 'string' &&
  process.env['VITE_SUPABASE_URL'] !== '' &&
  typeof process.env['SUPABASE_SERVICE_ROLE_KEY'] === 'string' &&
  process.env['SUPABASE_SERVICE_ROLE_KEY'] !== '';

const itPlain = hasEnv ? it : it.skip;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function getBillingSettings(): Promise<{ taxRatePercent: number; taxInclusive: boolean }> {
  const { data } = await testDb.from('settings').select('value').eq('key', 'billing').maybeSingle();
  const value = (data?.value ?? {}) as { taxRatePercent?: number; taxInclusive?: boolean };
  return {
    taxRatePercent: value.taxRatePercent ?? 16,
    taxInclusive: value.taxInclusive ?? true,
  };
}

function deriveTotal(subtotal: number, taxRatePercent: number, taxInclusive: boolean): number {
  if (taxInclusive) return round2(subtotal);
  return round2(subtotal + round2(subtotal * (taxRatePercent / 100)));
}

async function getStaffAndShift(
  roles: ('cashier' | 'manager' | 'admin')[]
): Promise<{ staffId: string; shiftId: string }> {
  const { data: staff } = await testDb
    .from('profiles')
    .select('id')
    .in('role', roles)
    .limit(1)
    .single();
  if (!staff) throw new Error(`getStaffAndShift: no profile found for roles ${roles.join(',')}`);
  const staffId = staff.id as string;

  const { data: existing } = await testDb
    .from('shifts')
    .select('id')
    .eq('staff_id', staffId)
    .is('clock_out', null)
    .limit(1)
    .maybeSingle();
  if (existing) return { staffId, shiftId: existing.id as string };

  const { data: newShift, error } = await testDb
    .from('shifts')
    .insert({ staff_id: staffId, opening_cash: 0 })
    .select('id')
    .single();
  if (error || !newShift)
    throw new Error(`getStaffAndShift: shift create failed: ${error?.message ?? 'no row'}`);
  return { staffId, shiftId: newShift.id as string };
}

/**
 * A tagged manager with an open shift and a signed-in session, plus a fresh
 * single-use approval ticket for apply_custom_discount issued to that session
 * (process_direct_sale_atomic binds the ticket to p_staff_id). The returned
 * cleanup removes every row the fixture owns and asserts each delete.
 */
async function seedApprovedManager(): Promise<{
  staffId: string;
  shiftId: string;
  approvalId: string;
  cleanup: () => Promise<void>;
}> {
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? process.env['VITE_SUPABASE_URL'] ?? '';
  const anonKey =
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? process.env['VITE_SUPABASE_ANON_KEY'] ?? '';
  if (!anonKey) throw new Error('seedApprovedManager: VITE_SUPABASE_ANON_KEY is required');
  const pin = String(100000 + Math.floor(Math.random() * 900000));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `__promo_rpc_manager_${stamp}@test.local`;

  const { data: created, error: createErr } = await testDb.auth.admin.createUser({
    email,
    password: pin,
    email_confirm: true,
  });
  if (createErr || !created.user) throw new Error(`seedApprovedManager: create user: ${createErr?.message}`);
  const staffId = created.user.id;
  const { error: profileErr } = await testDb
    .from('profiles')
    .upsert({ id: staffId, name: `__promo_rpc_manager_${stamp}__`, email, role: 'manager', pin, is_active: true });
  if (profileErr) throw new Error(`seedApprovedManager: profile upsert: ${profileErr.message}`);
  const { data: shift, error: shiftErr } = await testDb
    .from('shifts')
    .insert({ staff_id: staffId, opening_cash: 0 })
    .select('id')
    .single();
  if (shiftErr || !shift) throw new Error(`seedApprovedManager: shift insert: ${shiftErr?.message ?? 'no row'}`);

  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password: pin });
  if (signInErr) throw new Error(`seedApprovedManager: sign in: ${signInErr.message}`);
  const { data: check, error: checkErr } = await (client as any).rpc('verify_staff_pin', {
    p_pin: pin,
    p_staff_id: null,
    p_required_action: 'apply_custom_discount',
  });
  if (checkErr || !check?.ok || typeof check.approval_id !== 'string') {
    throw new Error(`seedApprovedManager: approval: ${checkErr?.message ?? JSON.stringify(check)}`);
  }

  const cleanup = async (): Promise<void> => {
    // stock_movements (written for p_staff_id by the sale) and shifts both
    // restrict profile deletion; tickets and attempt rows are keyed by the id.
    expect((await testDb.from('stock_movements').delete().eq('staff_id', staffId)).error).toBeNull();
    expect((await (testDb as any).from('manager_approvals').delete().eq('caller_id', staffId)).error).toBeNull();
    expect((await (testDb as any).from('pin_attempts').delete().like('attempt_key', `%${staffId}%`)).error).toBeNull();
    expect((await testDb.from('shifts').delete().eq('staff_id', staffId)).error).toBeNull();
    expect((await testDb.from('profiles').delete().eq('id', staffId)).error).toBeNull();
    expect((await testDb.auth.admin.deleteUser(staffId)).error).toBeNull();
    const { count } = await testDb.from('profiles').select('id', { count: 'exact', head: true }).eq('id', staffId);
    expect(count).toBe(0);
  };

  return { staffId, shiftId: shift.id as string, approvalId: check.approval_id as string, cleanup };
}

async function getOrCreateOpenCaja(staffId: string): Promise<{ cajaId: string; created: boolean }> {
  const { data: existing } = await testDb
    .from('caja_sessions')
    .select('id')
    .eq('status', 'open')
    .maybeSingle();
  if (existing) return { cajaId: existing.id as string, created: false };

  const { data, error } = await testDb
    .from('caja_sessions')
    .insert({ opened_by: staffId, opening_cash: 0 })
    .select('id')
    .single();
  if (error || !data)
    throw new Error(`getOrCreateOpenCaja: create failed: ${error?.message ?? 'no row'}`);
  return { cajaId: data.id as string, created: true };
}

interface ProductFixture {
  categoryId: string;
  productId: string;
  basePrice: number;
  costPrice: number;
}

/** Seeds an isolated category + product + inventory row. */
async function seedProduct(basePrice: number, costPrice: number): Promise<ProductFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { data: category, error: catErr } = await testDb
    .from('categories')
    .insert({ name: `Promo Test Category ${suffix}` })
    .select('id')
    .single();
  if (catErr || !category)
    throw new Error(`seedProduct: category insert failed: ${catErr?.message ?? 'no row'}`);

  const { data: product, error: prodErr } = await testDb
    .from('products')
    .insert({
      name: `Promo Test Product ${suffix}`,
      category_id: category.id,
      base_price: basePrice,
      is_active: true,
    })
    .select('id')
    .single();
  if (prodErr || !product)
    throw new Error(`seedProduct: product insert failed: ${prodErr?.message ?? 'no row'}`);

  const { error: invErr } = await testDb
    .from('inventory')
    .insert({ product_id: product.id, quantity_on_hand: 100, cost_price: costPrice });
  if (invErr) throw new Error(`seedProduct: inventory insert failed: ${invErr.message}`);

  return {
    categoryId: category.id as string,
    productId: product.id as string,
    basePrice,
    costPrice,
  };
}

async function seedPromotion(
  productId: string,
  discountType: 'percent' | 'fixed',
  discountValue: number
): Promise<Promotion> {
  const now = new Date();
  const startsAt = new Date(now.getTime() - 60_000);
  const endsAt = new Date(now.getTime() + 60 * 60_000);
  const { data, error } = await testDb
    .from('promotions')
    .insert({
      name: `Promo Test ${Date.now()}`,
      discount_type: discountType,
      discount_value: discountValue,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .select('*')
    .single();
  if (error || !data)
    throw new Error(`seedPromotion: insert failed: ${error?.message ?? 'no row'}`);
  const { data: targetRow, error: targetError } = await testDb
    .from('promotion_targets')
    .insert({ promotion_id: data.id as string, product_id: productId })
    .select('*')
    .single();
  if (targetError || !targetRow) {
    throw new Error(`seedPromotion: target insert failed: ${targetError?.message ?? 'no row'}`);
  }
  return {
    id: data.id as string,
    name: data.name as string,
    targets: [
      {
        id: targetRow.id as string,
        promotionId: data.id as string,
        productId: targetRow.product_id as string | null,
        categoryId: targetRow.category_id as string | null,
      },
    ],
    kind: (data as { kind?: string }).kind === 'combo' ? 'combo' : 'discount',
    discountType: data.discount_type as 'percent' | 'fixed',
    discountValue: data.discount_value as number,
    startsAt: new Date(data.starts_at as string),
    endsAt: new Date(data.ends_at as string),
    daysOfWeek: data.days_of_week as number[] | null,
    startTime: data.start_time as string | null,
    endTime: data.end_time as string | null,
    needsReview: data.needs_review as boolean,
    active: data.active as boolean,
    createdAt: new Date(data.created_at as string),
    createdBy: data.created_by as string | null,
    slots: [],
  };
}

/** Deletes everything the RPC creates for one sale, plus the fixture rows. */
async function cleanupSale(
  tabId: string | undefined,
  fixture: ProductFixture,
  promotionId?: string
): Promise<void> {
  if (tabId) {
    await testDb.from('payments').delete().eq('tab_id', tabId);
    const { data: orders } = await testDb.from('orders').select('id').eq('tab_id', tabId);
    const orderIds = (orders ?? []).map(o => o.id as string);
    if (orderIds.length > 0) {
      await testDb.from('order_items').delete().in('order_id', orderIds);
      await testDb.from('orders').delete().in('id', orderIds);
    }
    await testDb.from('tabs').delete().eq('id', tabId);
  }
  if (promotionId) await testDb.from('promotions').delete().eq('id', promotionId);
  await testDb.from('inventory').delete().eq('product_id', fixture.productId);
  await testDb.from('products').delete().eq('id', fixture.productId);
  await testDb.from('categories').delete().eq('id', fixture.categoryId);
}

/** Seeds an isolated category + product + inventory row for combo tests (products.combo_eligible defaults true). */
async function seedComboProduct(
  label: string,
  basePrice: number,
  costPrice: number,
  comboEligible = true
): Promise<ProductFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { data: category, error: catErr } = await testDb
    .from('categories')
    .insert({ name: `Combo Test Category ${label} ${suffix}` })
    .select('id')
    .single();
  if (catErr || !category)
    throw new Error(`seedComboProduct: category insert failed: ${catErr?.message ?? 'no row'}`);

  const { data: product, error: prodErr } = await testDb
    .from('products')
    .insert({
      name: `Combo Test Product ${label} ${suffix}`,
      category_id: category.id,
      base_price: basePrice,
      is_active: true,
      combo_eligible: comboEligible,
    })
    .select('id')
    .single();
  if (prodErr || !product)
    throw new Error(`seedComboProduct: product insert failed: ${prodErr?.message ?? 'no row'}`);

  const { error: invErr } = await testDb
    .from('inventory')
    .insert({ product_id: product.id, quantity_on_hand: 100, cost_price: costPrice });
  if (invErr) throw new Error(`seedComboProduct: inventory insert failed: ${invErr.message}`);

  return {
    categoryId: category.id as string,
    productId: product.id as string,
    basePrice,
    costPrice,
  };
}

interface ComboSlotSpec {
  quantity: number;
  productId?: string;
  categoryId?: string;
}

/** Seeds a kind='combo' promotion with ordered slots + their targets. */
async function seedComboPromotion(
  discountType: 'percent' | 'fixed' | 'bundle_price' | 'cheapest_free',
  discountValue: number,
  slots: ComboSlotSpec[]
): Promise<string> {
  const now = new Date();
  const startsAt = new Date(now.getTime() - 60_000);
  const endsAt = new Date(now.getTime() + 60 * 60_000);
  const { data, error } = await testDb
    .from('promotions')
    .insert({
      name: `Combo Test Promo ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'combo',
      discount_type: discountType,
      discount_value: discountValue,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .select('id')
    .single();
  if (error || !data)
    throw new Error(`seedComboPromotion: insert failed: ${error?.message ?? 'no row'}`);
  const promotionId = data.id as string;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const { data: slotRow, error: slotErr } = await testDb
      .from('promotion_combo_slots')
      .insert({ promotion_id: promotionId, position: i, quantity: slot.quantity })
      .select('id')
      .single();
    if (slotErr || !slotRow)
      throw new Error(`seedComboPromotion: slot insert failed: ${slotErr?.message ?? 'no row'}`);
    const { error: targetErr } = await testDb.from('promotion_targets').insert({
      promotion_id: promotionId,
      product_id: slot.productId ?? null,
      category_id: slot.categoryId ?? null,
      slot_id: slotRow.id as string,
    });
    if (targetErr)
      throw new Error(`seedComboPromotion: target insert failed: ${targetErr.message}`);
  }

  return promotionId;
}

/** Deletes everything a combo-pricing sale creates, plus the fixture rows and promotions. */
async function cleanupCombo(
  tabId: string | undefined,
  fixtures: ProductFixture[],
  promotionIds: string[]
): Promise<void> {
  if (tabId) {
    await testDb.from('payments').delete().eq('tab_id', tabId);
    const { data: orders } = await testDb.from('orders').select('id').eq('tab_id', tabId);
    const orderIds = (orders ?? []).map(o => o.id as string);
    if (orderIds.length > 0) {
      await testDb.from('order_items').delete().in('order_id', orderIds);
      await testDb.from('orders').delete().in('id', orderIds);
    }
    await testDb.from('tabs').delete().eq('id', tabId);
  }
  for (const promotionId of promotionIds) {
    await testDb.from('promotion_targets').delete().eq('promotion_id', promotionId);
    await testDb.from('promotion_combo_slots').delete().eq('promotion_id', promotionId);
    await testDb.from('promotions').delete().eq('id', promotionId);
  }
  // Two passes, not one per fixture: a scenario may reassign several
  // products onto one shared category (products.category_id is
  // ON DELETE RESTRICT), so every product must be gone before any category
  // delete is attempted, or a still-referenced category's delete 23503s.
  for (const fixture of fixtures) {
    await testDb.from('inventory').delete().eq('product_id', fixture.productId);
    await testDb.from('products').delete().eq('id', fixture.productId);
  }
  const categoryIds = [...new Set(fixtures.map(f => f.categoryId))];
  for (const categoryId of categoryIds) {
    await testDb.from('categories').delete().eq('id', categoryId);
  }
}

interface OrderItemRow {
  quantity: number;
  unit_price: number;
  promotion_id: string | null;
  discount_rate: number | null;
  discount_amount: number | null;
  product_id: string;
}

async function fetchOrderItems(tabId: string): Promise<OrderItemRow[]> {
  const { data: orders } = await testDb.from('orders').select('id').eq('tab_id', tabId);
  const orderIds = (orders ?? []).map(o => o.id as string);
  const { data } = await testDb
    .from('order_items')
    .select('quantity, unit_price, promotion_id, discount_rate, discount_amount, product_id')
    .in('order_id', orderIds);
  return (data ?? []) as unknown as OrderItemRow[];
}

describe('process_direct_sale_atomic — promotions + floor guard (integration)', () => {
  itPlain(
    'normal case: a matching product-scoped promotion recomputes the discount server-side, snapshots it on order_items, and matches evaluateBestPromotion() (parity backstop)',
    async () => {
      const basePrice = 100;
      const costPrice = 50; // discounted price (80) stays above cost — no floor guard trip
      const fixture = await seedProduct(basePrice, costPrice);
      const promotion = await seedPromotion(fixture.productId, 'percent', 20);
      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();

      const expected = evaluateBestPromotion(
        { productId: fixture.productId, categoryId: fixture.categoryId, basePrice },
        [promotion],
        new Date(),
        15,
        null,
        14,
        'America/Mexico_City'
      );
      expect(expected).not.toBeNull();

      const subtotal = expected!.discountedUnitPrice;
      const amount = deriveTotal(subtotal, taxRatePercent, taxInclusive);
      const idKey = `promo-normal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            {
              product_id: fixture.productId,
              quantity: 1,
              unit_price: basePrice,
              modifier_ids: [],
              modifier_price_delta: 0,
              notes: '',
            },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        expect((data as { ok?: boolean } | null)?.ok).toBe(true);
        tabId = (data as { tabId?: string }).tabId;
        expect(tabId).toBeTruthy();

        const { data: orders } = await testDb
          .from('orders')
          .select('id')
          .eq('tab_id', tabId as string);
        const orderIds = (orders ?? []).map(o => o.id as string);
        const { data: orderItems } = await testDb
          .from('order_items')
          .select('unit_price, promotion_id, discount_rate, discount_amount')
          .in('order_id', orderIds);
        expect(orderItems).toHaveLength(1);
        const row = orderItems![0] as {
          unit_price: number;
          promotion_id: string | null;
          discount_rate: number | null;
          discount_amount: number | null;
        };
        expect(Number(row.unit_price)).toBe(expected!.discountedUnitPrice);
        expect(row.promotion_id).toBe(expected!.promotionId);
        expect(Number(row.discount_rate)).toBe(expected!.discountRate);
        expect(Number(row.discount_amount)).toBe(expected!.discountAmount);
      } finally {
        await cleanupSale(tabId, fixture, promotion.id);
      }
    }
  );

  itPlain(
    'below-cost case: p_manager_override=false is blocked with BELOW_COST_REQUIRES_OVERRIDE',
    async () => {
      const basePrice = 100;
      const costPrice = 90; // discounted price (70) falls below cost (90)
      const fixture = await seedProduct(basePrice, costPrice);
      const promotion = await seedPromotion(fixture.productId, 'fixed', 30);
      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const idKey = `promo-belowcost-block-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            {
              product_id: fixture.productId,
              quantity: 1,
              unit_price: basePrice,
              modifier_ids: [],
              modifier_price_delta: 0,
              notes: '',
            },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: 70,
          p_tendered_amount: 70,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; code?: string };
        expect(result.ok).toBe(false);
        expect(result.code).toBe('BELOW_COST_REQUIRES_OVERRIDE');

        // The floor guard RETURNs from inside the per-item loop, before the
        // tabs/orders/order_items INSERT block runs — no order_item should
        // ever reference this freshly-created, uniquely-named product.
        const { data: leaked } = await testDb
          .from('order_items')
          .select('id')
          .eq('product_id', fixture.productId);
        expect(leaked ?? []).toHaveLength(0);
      } finally {
        await cleanupSale(undefined, fixture, promotion.id);
      }
    }
  );

  itPlain(
    'below-cost case: p_manager_override=true with a manager-role staff member succeeds',
    async () => {
      const basePrice = 100;
      const costPrice = 90;
      const fixture = await seedProduct(basePrice, costPrice);
      const promotion = await seedPromotion(fixture.productId, 'fixed', 30);
      // The caja is opened by an existing staff member; the sale itself is
      // made by a tagged manager whose session holds the approval ticket.
      const { staffId: cajaStaffId } = await getStaffAndShift(['manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(cajaStaffId);
      const { staffId, shiftId, approvalId, cleanup: cleanupManager } = await seedApprovedManager();
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      const amount = deriveTotal(70, taxRatePercent, taxInclusive);
      const idKey = `promo-belowcost-override-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            {
              product_id: fixture.productId,
              quantity: 1,
              unit_price: basePrice,
              modifier_ids: [],
              modifier_price_delta: 0,
              notes: '',
            },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: true,
          p_approval_id: approvalId,
          p_approver_id: staffId,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();
      } finally {
        await cleanupSale(tabId, fixture, promotion.id);
        await cleanupManager();
      }
    }
  );
});

describe('process_direct_sale_atomic — combo pricing (integration, Task 4)', () => {
  itPlain(
    '3x2 (cheapest_free value 1, slot qty 3 on a category): frees the cheapest of 3 distinct products',
    async () => {
      // cost_price 0: the combo pass's re-materialization floor guard checks
      // the FINAL (post-combo) line price against cost — the freed unit ends
      // at price 0, so its cost must be <= 0 too (not testing the floor
      // guard here, just avoiding an incidental BELOW_COST_REQUIRES_OVERRIDE).
      const p1 = await seedComboProduct('3x2-A', 10, 0);
      const p2 = await seedComboProduct('3x2-B', 20, 0);
      const p3 = await seedComboProduct('3x2-C', 30, 0);
      const promotionId = await seedComboPromotion('cheapest_free', 1, [
        { quantity: 3, categoryId: p1.categoryId },
      ]);
      // All three products must share the combo's target category — reuse
      // p1's category for p2/p3 too (each seedComboProduct call makes its own
      // category, so re-point p2/p3 onto p1's category for this scenario).
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p2.productId);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p3.productId);

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      const amount = deriveTotal(50, taxRatePercent, taxInclusive); // 10+20+30 - 10 (cheapest freed)
      const idKey = `combo-3x2-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p1.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p2.productId, quantity: 1, unit_price: 20, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p3.productId, quantity: 1, unit_price: 30, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        expect(rows).toHaveLength(3);
        const cheapRow = rows.find(r => r.product_id === p1.productId);
        expect(cheapRow).toBeDefined();
        expect(Number(cheapRow!.unit_price)).toBe(0);
        expect(Number(cheapRow!.discount_amount)).toBe(10);
        expect(cheapRow!.promotion_id).toBe(promotionId);

        const total = rows.reduce((sum, r) => sum + Number(r.unit_price) * r.quantity, 0);
        expect(Math.round(total * 100) / 100).toBe(50);
      } finally {
        await cleanupCombo(tabId, [p1, p2, p3], [promotionId]);
      }
    }
  );

  itPlain(
    'split rows: qty 3 of ONE product produces a qty-2/discount-0 row and a qty-1/discount-10 row',
    async () => {
      const p = await seedComboProduct('split', 10, 0); // one unit ends at price 0 post-combo
      const promotionId = await seedComboPromotion('cheapest_free', 1, [
        { quantity: 3, categoryId: p.categoryId },
      ]);

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      const amount = deriveTotal(20, taxRatePercent, taxInclusive); // 3x10 - 10 (cheapest freed)
      const idKey = `combo-split-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p.productId, quantity: 3, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        expect(rows).toHaveLength(2);
        const fullPriceRow = rows.find(r => Number(r.discount_amount) === 0);
        const freeRow = rows.find(r => Number(r.discount_amount) === 10);
        expect(fullPriceRow).toBeDefined();
        expect(freeRow).toBeDefined();
        expect(fullPriceRow!.quantity).toBe(2);
        expect(Number(fullPriceRow!.unit_price)).toBe(10);
        expect(freeRow!.quantity).toBe(1);
        expect(Number(freeRow!.unit_price)).toBe(0);
        expect(fullPriceRow!.quantity + freeRow!.quantity).toBe(3);
      } finally {
        await cleanupCombo(tabId, [p], [promotionId]);
      }
    }
  );

  itPlain(
    'bundle_price 25 over two product-specific slots priced 20/10: both rows discounted, Σ discount×qty = 5',
    async () => {
      const p1 = await seedComboProduct('bundle-A', 20, 1);
      const p2 = await seedComboProduct('bundle-B', 10, 1);
      const promotionId = await seedComboPromotion('bundle_price', 25, [
        { quantity: 1, productId: p1.productId },
        { quantity: 1, productId: p2.productId },
      ]);

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      const amount = deriveTotal(25, taxRatePercent, taxInclusive); // 20+10 - 5 gross
      const idKey = `combo-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p1.productId, quantity: 1, unit_price: 20, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p2.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        expect(rows).toHaveLength(2);
        for (const r of rows) {
          expect(Number(r.discount_amount)).toBeGreaterThan(0);
          expect(r.promotion_id).toBe(promotionId);
        }
        const totalDiscount = rows.reduce((sum, r) => sum + Number(r.discount_amount) * r.quantity, 0);
        expect(Math.round(totalDiscount * 100) / 100).toBe(5);
      } finally {
        await cleanupCombo(tabId, [p1, p2], [promotionId]);
      }
    }
  );

  itPlain(
    'eligibility: a product with combo_eligible=false in the target category is never consumed — full price',
    async () => {
      const p = await seedComboProduct('ineligible', 10, 1, false);
      const promotionId = await seedComboPromotion('cheapest_free', 1, [
        { quantity: 1, categoryId: p.categoryId },
      ]);

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      const amount = deriveTotal(10, taxRatePercent, taxInclusive); // no combo applies
      const idKey = `combo-ineligible-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]!.unit_price)).toBe(10);
        expect(Number(rows[0]!.discount_amount ?? 0)).toBe(0);
        expect(rows[0]!.promotion_id).toBeNull();
      } finally {
        await cleanupCombo(tabId, [p], [promotionId]);
      }
    }
  );

  itPlain(
    'per-line promotion beats the combo when it is better: rows carry the discount promotion id, not the combo id',
    async () => {
      const p1 = await seedComboProduct('perline-A', 10, 1);
      const p2 = await seedComboProduct('perline-B', 20, 1);
      const p3 = await seedComboProduct('perline-C', 30, 1);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p2.productId);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p3.productId);

      const comboId = await seedComboPromotion('cheapest_free', 1, [
        { quantity: 3, categoryId: p1.categoryId },
      ]);
      const discountId = await seedPromotion(p1.productId, 'percent', 50);
      // seedPromotion only targets p1 by product id; add category-wide
      // targets so p2/p3 get the 50% discount too (store-wide targeting via
      // an explicit category target, same junction table combos use).
      await testDb
        .from('promotion_targets')
        .insert({ promotion_id: discountId.id, category_id: p1.categoryId });

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      // 50% off each line (5+10+15=30) beats the combo's gross (10, freeing
      // the cheapest unit) net of the per-line discount already applied
      // (10 - 30 <= 0) -> combo never applies; per-line discount wins.
      const amount = deriveTotal(30, taxRatePercent, taxInclusive);
      const idKey = `combo-perline-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p1.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p2.productId, quantity: 1, unit_price: 20, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p3.productId, quantity: 1, unit_price: 30, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        expect(rows).toHaveLength(3);
        for (const r of rows) {
          expect(r.promotion_id).toBe(discountId.id);
          expect(r.promotion_id).not.toBe(comboId);
          expect(Number(r.discount_rate)).toBe(50);
        }
        const p1Row = rows.find(r => r.product_id === p1.productId);
        const p2Row = rows.find(r => r.product_id === p2.productId);
        const p3Row = rows.find(r => r.product_id === p3.productId);
        expect(Number(p1Row!.unit_price)).toBe(5);
        expect(Number(p2Row!.unit_price)).toBe(10);
        expect(Number(p3Row!.unit_price)).toBe(15);
      } finally {
        await cleanupCombo(tabId, [p1, p2, p3], [comboId, discountId.id]);
      }
    }
  );

  itPlain(
    'clamp-fix regression: bundle_price 0.95 over 4 product-specific slots (42.84/18.79/29.22/0.09) never drives a unit negative',
    async () => {
      // Cross-checks Task 3's client-side clamp fix (combo-pricing.test.ts's
      // "bundle_price proportional remainder is clamped..." case, same repro
      // numbers) against this migration's ported plpgsql clamp/redistribute
      // pass. Without the fix, the naive "remainder on the last unit"
      // allocation would try to discount the 0.09 unit by ~0.10, driving its
      // unit_price negative in order_items.
      const a = await seedComboProduct('clamp-A', 42.84, 0);
      const b = await seedComboProduct('clamp-B', 18.79, 0);
      const c = await seedComboProduct('clamp-C', 29.22, 0);
      const d = await seedComboProduct('clamp-D', 0.09, 0);
      const promotionId = await seedComboPromotion('bundle_price', 0.95, [
        { quantity: 1, productId: a.productId },
        { quantity: 1, productId: b.productId },
        { quantity: 1, productId: c.productId },
        { quantity: 1, productId: d.productId },
      ]);

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      // bundle_price gross = sum(90.94) - 0.95 = 89.99; remaining subtotal
      // after the combo is exactly the bundle_price value (0.95) by
      // construction, regardless of how the discount is split per unit.
      const amount = deriveTotal(0.95, taxRatePercent, taxInclusive);
      const idKey = `combo-clamp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: a.productId, quantity: 1, unit_price: 42.84, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: b.productId, quantity: 1, unit_price: 18.79, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: c.productId, quantity: 1, unit_price: 29.22, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: d.productId, quantity: 1, unit_price: 0.09, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string; code?: string; message?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        expect(rows).toHaveLength(4);

        // The core clamp-fix assertions: no row ever goes negative, and no
        // row's discount exceeds its own reconstructed catalog price.
        for (const r of rows) {
          const catalogPrice = Math.round((Number(r.unit_price) + Number(r.discount_amount ?? 0)) * 100) / 100;
          expect(Number(r.unit_price)).toBeGreaterThanOrEqual(0);
          expect(Number(r.discount_amount ?? 0)).toBeLessThanOrEqual(catalogPrice + 1e-9);
        }
        const dRow = rows.find(r => r.product_id === d.productId);
        expect(dRow).toBeDefined();
        expect(Number(dRow!.unit_price)).toBeGreaterThanOrEqual(0);
        expect(Number(dRow!.discount_amount)).toBeLessThanOrEqual(0.09);

        const totalDiscount = rows.reduce((sum, r) => sum + Number(r.discount_amount ?? 0), 0);
        expect(Math.round(totalDiscount * 100) / 100).toBe(89.99);
        const netSubtotal = rows.reduce((sum, r) => sum + Number(r.unit_price) * r.quantity, 0);
        expect(Math.round(netSubtotal * 100) / 100).toBe(0.95);
      } finally {
        await cleanupCombo(tabId, [a, b, c, d], [promotionId]);
      }
    }
  );

  itPlain(
    'CRITICAL FIX regression: two simultaneously-active combos targeting the SAME pool — the winning (highest-net) combo discounts the correct units, not a losing candidate\'s leftover scratch array',
    async () => {
      // Reproduces the round-1 review's Critical finding: the per-slot
      // scratch pick used to be written into the SAME variable
      // (v_best_units) that holds the eventual winner's units, unconditionally,
      // for every slot of every candidate combo — not just the winner.
      //
      // comboB deliberately targets the SAME category X as comboA (rather
      // than a disjoint product) so it can never independently win in a
      // LATER round either: once comboA consumes all 3 units in round 1,
      // comboB has zero eligible candidates left in round 2 and fails to
      // fill — the only way comboB's units could ever end up discounted is
      // via the round-1 aliasing bug itself, not via legitimate multi-round
      // application (a combo targeting a genuinely disjoint product, e.g.
      // one nobody else wants, WOULD legitimately win in a later round —
      // that's correct multi-application behaviour, not this bug).
      //
      // Candidates are evaluated `ORDER BY created_at DESC` (newest first):
      // comboA (newer) is evaluated FIRST and correctly recorded as the
      // winner (net 10 > comboB's net 1) — but comboB (older), evaluated
      // SECOND in the same round, still runs its own (successful, 1-unit)
      // slot-fill afterwards. Under the bug that slot-fill's scratch write
      // clobbered v_best_units (aliased to the same variable) with comboB's
      // single highest-priced pick (p3) right before the allocation step
      // read it — so the allocation would apply comboA's cheapest_free
      // logic over comboB's leftover [p3] instead of comboA's real
      // [p1,p2,p3], freeing p3 (price 30) instead of p1 (price 10). This
      // test fails under the bug (wrong unit freed / wrong total) and
      // passes under the fix.
      const p1 = await seedComboProduct('multi-A', 10, 0);
      const p2 = await seedComboProduct('multi-B', 20, 0);
      const p3 = await seedComboProduct('multi-C', 30, 0);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p2.productId);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p3.productId);

      const now = new Date();
      // comboA (newer, created_at ~now): cheapest_free over category X
      // (p1/p2/p3) — gross 10 (frees the cheapest, p1), net 10.
      const comboAId = await seedComboPromotion('cheapest_free', 1, [
        { quantity: 3, categoryId: p1.categoryId },
      ]);
      // comboB (older, created_at 1 day earlier): fixed 1, ALSO over
      // category X (quantity-1 slot) — gross LEAST(1, price-of-whichever-
      // unit-it-picks) = 1, net 1. Always loses to comboA's net 10 within
      // round 1, and has nothing left to match in round 2 once comboA
      // consumes all 3 units, so it must never actually apply.
      const { data: comboBRow, error: comboBErr } = await testDb
        .from('promotions')
        .insert({
          name: `Combo Test Promo B ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'combo',
          discount_type: 'fixed',
          discount_value: 1,
          starts_at: new Date(now.getTime() - 24 * 60 * 60_000 - 60_000).toISOString(),
          ends_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
          created_at: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
        })
        .select('id')
        .single();
      if (comboBErr || !comboBRow) throw new Error(`comboB insert failed: ${comboBErr?.message ?? 'no row'}`);
      const comboBId = comboBRow.id as string;
      const { data: comboBSlot, error: comboBSlotErr } = await testDb
        .from('promotion_combo_slots')
        .insert({ promotion_id: comboBId, position: 0, quantity: 1 })
        .select('id')
        .single();
      if (comboBSlotErr || !comboBSlot) throw new Error(`comboB slot insert failed: ${comboBSlotErr?.message ?? 'no row'}`);
      await testDb.from('promotion_targets').insert({
        promotion_id: comboBId,
        category_id: p1.categoryId,
        slot_id: comboBSlot.id as string,
      });

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      // (10+20+30) - 10 (comboA frees p1) = 50; comboB never applies.
      const amount = deriveTotal(50, taxRatePercent, taxInclusive);
      const idKey = `combo-multi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p1.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p2.productId, quantity: 1, unit_price: 20, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p3.productId, quantity: 1, unit_price: 30, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string; code?: string; message?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        expect(rows).toHaveLength(3);
        const p1Row = rows.find(r => r.product_id === p1.productId);
        const p2Row = rows.find(r => r.product_id === p2.productId);
        const p3Row = rows.find(r => r.product_id === p3.productId);

        // comboA's units, correctly: p1 (cheapest) freed, p2/p3 at full
        // price, all three carrying comboA's id (not comboB's, and not a
        // wrong unit like p3 being freed instead of p1 — the exact
        // corruption the aliasing bug produced).
        expect(Number(p1Row!.unit_price)).toBe(0);
        expect(Number(p1Row!.discount_amount)).toBe(10);
        expect(p1Row!.promotion_id).toBe(comboAId);
        expect(Number(p2Row!.unit_price)).toBe(20);
        expect(Number(p2Row!.discount_amount ?? 0)).toBe(0);
        expect(p2Row!.promotion_id).toBe(comboAId);
        expect(Number(p3Row!.unit_price)).toBe(30);
        expect(Number(p3Row!.discount_amount ?? 0)).toBe(0);
        expect(p3Row!.promotion_id).toBe(comboAId);
      } finally {
        await cleanupCombo(tabId, [p1, p2, p3], [comboAId, comboBId]);
      }
    }
  );

  itPlain(
    'floor guard is scoped to the whole application: a 3x2 whose freed unit alone would trip a naive per-row check succeeds without override',
    async () => {
      // p1 (freed, price 10) has cost_price 5 — its own post-combo row
      // (unit_price 0) is below its own cost, which is exactly what the
      // PRIOR (per-row) floor guard checked and would have blocked. The
      // application's aggregate revenue (0 + 20 + 30 = 50) comfortably
      // covers the aggregate cost (5 + 1 + 1 = 7), so the corrected
      // application-level guard must let this through with no override.
      const p1 = await seedComboProduct('floor-ok-A', 10, 5);
      const p2 = await seedComboProduct('floor-ok-B', 20, 1);
      const p3 = await seedComboProduct('floor-ok-C', 30, 1);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p2.productId);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p3.productId);
      const promotionId = await seedComboPromotion('cheapest_free', 1, [
        { quantity: 3, categoryId: p1.categoryId },
      ]);

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      const amount = deriveTotal(50, taxRatePercent, taxInclusive);
      const idKey = `combo-floor-ok-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p1.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p2.productId, quantity: 1, unit_price: 20, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p3.productId, quantity: 1, unit_price: 30, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string; code?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        const p1Row = rows.find(r => r.product_id === p1.productId);
        expect(Number(p1Row!.unit_price)).toBe(0);
      } finally {
        await cleanupCombo(tabId, [p1, p2, p3], [promotionId]);
      }
    }
  );

  itPlain(
    'floor guard is scoped to the whole application: an application that IS below cost in aggregate still requires manager override',
    async () => {
      // Costs 9/19/29 vs prices 10/20/30: EVERY individual item clears the
      // pre-existing per-line floor guard on its own (10>=9, 20>=19, 30>=29
      // — that guard runs before the combo pass even starts, so it would
      // have silently swallowed this test if left at any cost >= its own
      // price, as an earlier fixture (100/100/100) mistakenly did — that
      // fixture tripped the OLD per-line guard on the very first item
      // (10<100) and returned BELOW_COST_REQUIRES_OVERRIDE regardless of
      // whether the NEW application-level guard being tested here worked at
      // all. Only the aggregate is short: application revenue
      // (10-10)+(20-0)+(30-0)=50 vs application cost 9+19+29=57 — 50 < 57 —
      // so ONLY the new per-app_no guard can catch this.
      const p1 = await seedComboProduct('floor-bad-A', 10, 9);
      const p2 = await seedComboProduct('floor-bad-B', 20, 19);
      const p3 = await seedComboProduct('floor-bad-C', 30, 29);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p2.productId);
      await testDb.from('products').update({ category_id: p1.categoryId }).eq('id', p3.productId);
      const promotionId = await seedComboPromotion('cheapest_free', 1, [
        { quantity: 3, categoryId: p1.categoryId },
      ]);

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const idKey = `combo-floor-bad-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p1.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p2.productId, quantity: 1, unit_price: 20, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p3.productId, quantity: 1, unit_price: 30, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: 50, // irrelevant — expected to be rejected before payment
          p_tendered_amount: 50,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; code?: string };
        expect(result.ok).toBe(false);
        expect(result.code).toBe('BELOW_COST_REQUIRES_OVERRIDE');

        const { data: leaked } = await testDb
          .from('order_items')
          .select('id')
          .eq('product_id', p1.productId);
        expect(leaked ?? []).toHaveLength(0);
      } finally {
        await cleanupCombo(undefined, [p1, p2, p3], [promotionId]);
      }
    }
  );

  itPlain(
    'a line with its own per-line promotion, untouched by any combo, keeps its original promotion_id/discount_rate/discount_amount after the combo pass runs',
    async () => {
      // p1 (category Z) carries a 20%-off per-line discount promotion and is
      // NOT a target of comboY (category Y, p2/p3) — but comboY DOES apply
      // to p2/p3, so the re-materialization block runs. p1 must come through
      // the "unconsumed" (ELSE) branch of that block completely unchanged.
      const p1 = await seedComboProduct('untouched', 10, 1);
      const p2 = await seedComboProduct('comboY-A', 20, 0);
      const p3 = await seedComboProduct('comboY-B', 10, 0);
      await testDb.from('products').update({ category_id: p2.categoryId }).eq('id', p3.productId);
      const discountPromo = await seedPromotion(p1.productId, 'percent', 20);
      const promotionId = await seedComboPromotion('cheapest_free', 1, [
        { quantity: 2, categoryId: p2.categoryId },
      ]);

      const { staffId, shiftId } = await getStaffAndShift(['cashier', 'manager', 'admin']);
      const { cajaId } = await getOrCreateOpenCaja(staffId);
      const { taxRatePercent, taxInclusive } = await getBillingSettings();
      // p1: 10 - 2 (20% off) = 8. p2/p3: 20+10-10 (comboY frees cheapest, p3) = 20.
      const amount = deriveTotal(28, taxRatePercent, taxInclusive);
      const idKey = `combo-untouched-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let tabId: string | undefined;
      try {
        const { data, error } = await testDb.rpc('process_direct_sale_atomic', {
          p_staff_id: staffId,
          p_shift_id: shiftId,
          p_caja_session_id: cajaId,
          p_items: [
            { product_id: p1.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p2.productId, quantity: 1, unit_price: 20, modifier_ids: [], modifier_price_delta: 0, notes: '' },
            { product_id: p3.productId, quantity: 1, unit_price: 10, modifier_ids: [], modifier_price_delta: 0, notes: '' },
          ],
          p_idempotency_key: idKey,
          p_method: 'cash',
          p_amount: amount,
          p_tendered_amount: amount,
          p_manager_override: false,
        } as never);

        expect(error).toBeNull();
        const result = data as { ok?: boolean; tabId?: string };
        expect(result.ok).toBe(true);
        tabId = result.tabId;
        expect(tabId).toBeTruthy();

        const rows = await fetchOrderItems(tabId as string);
        expect(rows).toHaveLength(3);
        const p1Row = rows.find(r => r.product_id === p1.productId);
        expect(p1Row).toBeDefined();
        expect(p1Row!.promotion_id).toBe(discountPromo.id);
        expect(Number(p1Row!.discount_rate)).toBe(20);
        expect(Number(p1Row!.discount_amount)).toBe(2);
        expect(Number(p1Row!.unit_price)).toBe(8);

        const p3Row = rows.find(r => r.product_id === p3.productId);
        expect(Number(p3Row!.unit_price)).toBe(0);
        expect(p3Row!.promotion_id).toBe(promotionId);
      } finally {
        await cleanupCombo(tabId, [p1, p2, p3], [promotionId, discountPromo.id]);
      }
    }
  );
});
