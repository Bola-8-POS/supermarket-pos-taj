import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test for Phase 27 (27-02 tracer + 27-03 hardening). Proves the
 * whole spine end-to-end against the live remote schema: open_units table,
 * products.parent_product_id/units_per_package, consume_open_unit, and the
 * deplete_for_order_item chokepoint branch — then hardens it with
 * concurrency, unit-boundary-crossing, exhaustion/override, and refund
 * credit-back scenarios (27-VALIDATION.md Per-Task Verification Map rows 2-5
 * and 7; threats T-27-01, T-27-02, T-27-03, T-27-05, T-27-08).
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and
 * SUPABASE_SERVICE_ROLE_KEY in environment (describe.skipIf below).
 *
 * Reuses src/entities/tab/model/depletion.integration.test.ts's skeleton
 * verbatim: a service-role client (`db`) for RLS-bypassing setup/teardown,
 * an authenticated client (`anonClient`) because deplete_for_order_item /
 * consume_open_unit call auth.uid() internally, and a temporary test user
 * created in beforeAll / torn down in afterAll.
 *
 * The test drives depletion exclusively through the deplete_for_order_item
 * RPC (the real chokepoint) — it never invokes the nested consume-side
 * function directly. This is the assertion that the nesting resolution
 * (27-02-PLAN.md objective, resolved Open Question 1) actually holds: if the
 * branch were missing, the call below would silently succeed and leave no
 * open_units row.
 *
 * The 4 migrations (open_units table, products linkage columns,
 * consume_open_unit RPC, deplete_for_order_item v5) are live on the remote
 * bar-pos Supabase Cloud project (pushed and verified in 27-02) — this file
 * runs against that live schema whenever the env vars above are present.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

describe.skipIf(skip)('consume_open_unit integration (Phase 27 tracer spine)', () => {
  // Service-role client: setup, teardown, direct table queries (bypasses RLS).
  // persistSession/autoRefreshToken disabled so this client's Authorization
  // header cannot be silently swapped to the anonClient's session (both
  // clients share the same default GoTrueClient storage key against this
  // project URL) — see locale-rls.integration.test.ts for the same pattern.
  const db = createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
  // Authenticated client: used for the deplete_for_order_item RPC call (auth.uid())
  const anonClient = createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;

  let testUserId: string;
  let categoryId: string;
  let boxProductId: string;
  let looseProductId: string;
  let tabId: string;
  let orderId: string;
  let shiftId: string;
  let saleItemOneId: string;
  let saleItemTwoId: string;

  // -------------------------------------------------------------------
  // Plan 27-03 hardening fixtures (Scenarios R1-R4). Each scenario gets its
  // own BOX/LOOSE product pair so concurrency/boundary-crossing tests never
  // share mutable state with each other or with the 27-02 tracer test above.
  // Ids are tracked here so afterAll can clean everything up in FK-safe order.
  // -------------------------------------------------------------------
  const extraBoxProductIds: string[] = [];
  const extraLooseProductIds: string[] = [];
  const extraOrderItemIds: string[] = [];

  async function createBoxLoosePair(opts: {
    unitsPerPackage: number;
    boxStock: number;
  }): Promise<{ boxId: string; looseId: string }> {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const { data: box, error: boxErr } = await db
      .from('products')
      .insert({
        name: `__test_r_box_${suffix}__`,
        base_price: 100.0,
        category_id: categoryId,
        is_active: true,
        units_per_package: opts.unitsPerPackage,
      })
      .select('id')
      .single();
    if (boxErr) throw new Error(`hardening box product insert: ${boxErr.message}`);
    const boxId = (box as { id: string }).id;
    extraBoxProductIds.push(boxId);

    const { error: invErr } = await db
      .from('inventory')
      .insert({ product_id: boxId, quantity_on_hand: opts.boxStock });
    if (invErr) throw new Error(`hardening inventory insert: ${invErr.message}`);

    const { data: loose, error: looseErr } = await db
      .from('products')
      .insert({
        name: `__test_r_loose_${suffix}__`,
        base_price: 7.5,
        category_id: categoryId,
        is_active: true,
        parent_product_id: boxId,
      })
      .select('id')
      .single();
    if (looseErr) throw new Error(`hardening loose product insert: ${looseErr.message}`);
    const looseId = (loose as { id: string }).id;
    extraLooseProductIds.push(looseId);

    return { boxId, looseId };
  }

  async function insertLooseOrderItem(productId: string, quantity: number): Promise<string> {
    const { data, error } = await db
      .from('order_items')
      .insert({
        order_id: orderId,
        product_id: productId,
        quantity,
        unit_price: 7.5,
        modifier_price_delta: 0,
      })
      .select('id')
      .single();
    if (error) throw new Error(`hardening order_item insert: ${error.message}`);
    const itemId = (data as { id: string }).id;
    extraOrderItemIds.push(itemId);
    return itemId;
  }

  async function seedActiveUnit(boxId: string, remainingCount: number): Promise<string> {
    const { data, error } = await db
      .from('open_units')
      .insert({
        product_id: boxId,
        remaining_count: remainingCount,
        status: 'active',
        opened_by: testUserId,
      })
      .select('id')
      .single();
    if (error) throw new Error(`hardening seed active unit: ${error.message}`);
    return (data as { id: string }).id;
  }

  const BOX_UNITS_PER_PACKAGE = 20;
  const BOX_INITIAL_STOCK = 2;
  // D-03 regression fixture: the loose product's own base_price is
  // deliberately NOT box_price / units_per_package, so a future regression
  // that starts deriving the price fails this assertion.
  const BOX_BASE_PRICE = 100.0;
  const LOOSE_BASE_PRICE = 7.5; // != 100 / 20 (= 5.0)

  beforeAll(async () => {
    // 0. Temporary test user, signed in so anonClient carries auth.uid()
    const testEmail = `__open_unit_test_${Date.now()}@test.local`;
    const testPassword = 'TestOpenUnit123!';

    const { data: authUser, error: createErr } = await db.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true,
    });
    if (createErr || !authUser.user) throw new Error(`test user create: ${createErr?.message}`);
    testUserId = authUser.user.id;

    const { error: profileErr } = await db.from('profiles').upsert({
      id: testUserId,
      name: '__open_unit_test__',
      email: testEmail,
      role: 'cashier',
      pin: '999998',
      is_active: true,
    });
    if (profileErr) throw new Error(`profile upsert: ${profileErr.message}`);

    const { error: signInErr } = await anonClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    if (signInErr) throw new Error(`sign in: ${signInErr.message}`);

    // 1. Category
    const { data: cat, error: catErr } = await db
      .from('categories')
      .select('id')
      .limit(1)
      .single();
    if (catErr || !cat) throw new Error(`category lookup: ${catErr?.message ?? 'no categories'}`);
    categoryId = (cat as { id: string }).id;

    // 2. BOX product (units_per_package = 20)
    const { data: boxProd, error: boxErr } = await db
      .from('products')
      .insert({
        name: '__test_open_unit_box__',
        base_price: BOX_BASE_PRICE,
        category_id: categoryId,
        is_active: true,
        units_per_package: BOX_UNITS_PER_PACKAGE,
      })
      .select('id')
      .single();
    if (boxErr) throw new Error(`box product insert: ${boxErr.message}`);
    boxProductId = (boxProd as { id: string }).id;

    // 3. inventory row for the BOX product
    const { error: invErr } = await db
      .from('inventory')
      .insert({ product_id: boxProductId, quantity_on_hand: BOX_INITIAL_STOCK });
    if (invErr) throw new Error(`inventory insert: ${invErr.message}`);

    // 4. LOOSE product, linked to the BOX, distinct base_price (D-03)
    const { data: looseProd, error: looseErr } = await db
      .from('products')
      .insert({
        name: '__test_open_unit_loose__',
        base_price: LOOSE_BASE_PRICE,
        category_id: categoryId,
        is_active: true,
        parent_product_id: boxProductId,
      })
      .select('id')
      .single();
    if (looseErr) throw new Error(`loose product insert: ${looseErr.message}`);
    looseProductId = (looseProd as { id: string }).id;

    // 5. Tab + order using the test user as staff_id
    const { data: newShift, error: shiftErr } = await db
      .from('shifts')
      .insert({ staff_id: testUserId, opening_cash: 0 })
      .select('id')
      .single();
    if (shiftErr || !newShift) throw new Error(`shift insert: ${shiftErr?.message}`);
    shiftId = (newShift as { id: string }).id;

    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: '__test_open_unit_tab__',
        status: 'open',
        is_deleted: false,
        staff_id: testUserId,
        shift_id: shiftId,
      })
      .select('id')
      .single();
    if (tabErr) throw new Error(`tab insert: ${tabErr.message}`);
    tabId = (tab as { id: string }).id;

    const { data: order, error: orderErr } = await db
      .from('orders')
      .insert({ tab_id: tabId, status: 'pending', staff_id: testUserId })
      .select('id')
      .single();
    if (orderErr) throw new Error(`order insert: ${orderErr.message}`);
    orderId = (order as { id: string }).id;

    // 6. Two distinct order_items for the LOOSE product — one per sale call.
    const insertLooseItem = async () => {
      const { data, error } = await db
        .from('order_items')
        .insert({
          order_id: orderId,
          product_id: looseProductId,
          quantity: 1,
          unit_price: LOOSE_BASE_PRICE,
          modifier_price_delta: 0,
        })
        .select('id')
        .single();
      if (error) throw new Error(`order_item insert: ${error.message}`);
      return (data as { id: string }).id;
    };

    saleItemOneId = await insertLooseItem();
    saleItemTwoId = await insertLooseItem();
  });

  afterAll(async () => {
    await anonClient.auth.signOut();

    // Cleanup Scenario R1-R4 hardening fixtures first (FK-safe order): audit
    // rows referencing seeded/created open_units, the open_units rows
    // themselves, "discarded credit" audit rows (entity_id=NULL, keyed only
    // by details.order_item_id), the order_items, inventory rows, then the
    // LOOSE products (child) before the BOX products (parent FK).
    if (extraBoxProductIds.length > 0) {
      const { data: extraUnits } = await db
        .from('open_units')
        .select('id')
        .in('product_id', extraBoxProductIds);
      const extraUnitIds = ((extraUnits as { id: string }[] | null) ?? []).map(u => u.id);
      if (extraUnitIds.length > 0) {
        await db.from('audit_logs').delete().in('entity_id', extraUnitIds);
        await db.from('open_units').delete().in('id', extraUnitIds);
      }
    }

    if (extraOrderItemIds.length > 0) {
      const { data: orphanAudit } = await db
        .from('audit_logs')
        .select('id, after')
        .eq('entity_type', 'open_unit')
        .is('entity_id', null);
      const orphanAuditIds = ((orphanAudit as { id: string; after: { order_item_id?: string } | null }[] | null) ?? [])
        .filter(row => extraOrderItemIds.includes(row.after?.order_item_id ?? ''))
        .map(row => row.id);
      if (orphanAuditIds.length > 0) {
        await db.from('audit_logs').delete().in('id', orphanAuditIds);
      }

      await db.from('order_items').delete().in('id', extraOrderItemIds);
    }

    if (extraBoxProductIds.length > 0) {
      await db.from('inventory').delete().in('product_id', extraBoxProductIds);
    }
    if (extraLooseProductIds.length > 0) {
      await db.from('products').delete().in('id', extraLooseProductIds);
    }
    if (extraBoxProductIds.length > 0) {
      await db.from('products').delete().in('id', extraBoxProductIds);
    }

    // Cleanup audit_logs / open_units referencing the BOX product first (FK-safe order)
    if (boxProductId) {
      const { data: units } = await db
        .from('open_units')
        .select('id')
        .eq('product_id', boxProductId);
      const unitIds = ((units as { id: string }[] | null) ?? []).map(u => u.id);
      if (unitIds.length > 0) {
        await db.from('audit_logs').delete().in('entity_id', unitIds);
        await db.from('open_units').delete().in('id', unitIds);
      }
    }

    const itemIds = [saleItemOneId, saleItemTwoId].filter(Boolean);
    if (itemIds.length > 0) {
      await db.from('order_items').delete().in('id', itemIds);
    }

    if (orderId) await db.from('orders').delete().eq('id', orderId);
    if (tabId) await db.from('tabs').delete().eq('id', tabId);
    if (looseProductId) await db.from('products').delete().eq('id', looseProductId);
    if (boxProductId) {
      await db.from('inventory').delete().eq('product_id', boxProductId);
      await db.from('products').delete().eq('id', boxProductId);
    }

    if (testUserId) {
      await db.from('shifts').delete().eq('staff_id', testUserId);
      await db.from('profiles').delete().eq('id', testUserId);
      await db.auth.admin.deleteUser(testUserId);
    }
  });

  it('sells one loose piece end-to-end through deplete_for_order_item, auto-opening the box', async () => {
    // 1. No open_units row exists for the BOX product initially.
    const { data: before, error: beforeErr } = await db
      .from('open_units')
      .select('id')
      .eq('product_id', boxProductId);
    expect(beforeErr).toBeNull();
    expect(before).toHaveLength(0);

    // 2. Sell one loose piece through the real chokepoint.
    const { error: sellErr } = await anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: saleItemOneId,
      p_direction: 1,
      p_allow_negative: false,
    });
    expect(sellErr).toBeNull();

    // 3. Exactly one active open_units row now exists for the BOX product.
    const { data: units, error: unitsErr } = await db
      .from('open_units')
      .select('id, status, remaining_count, opened_by, opened_at')
      .eq('product_id', boxProductId);
    expect(unitsErr).toBeNull();
    expect(units).toHaveLength(1);
    const unit = (units as { id: string; status: string; remaining_count: number; opened_by: string | null; opened_at: string | null }[])[0]!;
    expect(unit.status).toBe('active');
    expect(unit.remaining_count).toBe(BOX_UNITS_PER_PACKAGE - 1);
    expect(unit.opened_by).not.toBeNull();
    expect(unit.opened_at).not.toBeNull();

    // 4. The BOX product's inventory dropped by one package.
    const { data: inv, error: invErr } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', boxProductId)
      .single();
    expect(invErr).toBeNull();
    expect((inv as { quantity_on_hand: number }).quantity_on_hand).toBe(BOX_INITIAL_STOCK - 1);

    // 5. audit_logs contains open_unit.open and open_unit.deplete for this unit.
    const { data: auditRows, error: auditErr } = await db
      .from('audit_logs')
      .select('action, source, actor_id')
      .eq('entity_type', 'open_unit')
      .eq('entity_id', unit.id);
    expect(auditErr).toBeNull();
    const actions = (auditRows as { action: string; source: string; actor_id: string | null }[]).map(r => r.action);
    expect(actions).toContain('open_unit.open');
    expect(actions).toContain('open_unit.deplete');
    for (const row of auditRows as { action: string; source: string; actor_id: string | null }[]) {
      expect(row.source).toBe('rpc');
      expect(row.actor_id).not.toBeNull();
    }

    // 6. A second quantity-1 sale reuses the same active unit — no second
    //    active row is created (D-07's partial unique index + the RPC's
    //    "reuse the active unit" targeting both hold).
    const { error: secondSellErr } = await anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: saleItemTwoId,
      p_direction: 1,
      p_allow_negative: false,
    });
    expect(secondSellErr).toBeNull();

    const { data: unitsAfterSecond, error: unitsAfterSecondErr } = await db
      .from('open_units')
      .select('id, status, remaining_count')
      .eq('product_id', boxProductId);
    expect(unitsAfterSecondErr).toBeNull();
    expect(unitsAfterSecond).toHaveLength(1);
    const unitAfterSecond = (unitsAfterSecond as { id: string; status: string; remaining_count: number }[])[0]!;
    expect(unitAfterSecond.id).toBe(unit.id);
    expect(unitAfterSecond.status).toBe('active');
    expect(unitAfterSecond.remaining_count).toBe(BOX_UNITS_PER_PACKAGE - 2);
  });

  // ===================================================================
  // Plan 27-03 hardening scenarios (27-VALIDATION.md rows 2-5, 7):
  // concurrency (T-27-01), unit-boundary crossing (SC-2, Pitfall 3),
  // exhaustion + the D-05 override, refund credit-back, and audit
  // coverage (SC-4). Each scenario uses its own fresh BOX/LOOSE pair and
  // its own fresh order_items.
  // ===================================================================

  it('R1: two concurrent sales racing on the last remaining piece — exactly one wins, final count is 0, no duplicate active unit (T-27-01, T-27-02)', async () => {
    const { boxId: r1BoxId, looseId: r1LooseId } = await createBoxLoosePair({
      unitsPerPackage: 20,
      boxStock: 0, // no unopened package available — the loser cannot mask the race with an auto-open
    });
    const r1UnitId = await seedActiveUnit(r1BoxId, 1);

    const r1ItemA = await insertLooseOrderItem(r1LooseId, 1);
    const r1ItemB = await insertLooseOrderItem(r1LooseId, 1);

    // Fire both calls before awaiting either — genuinely parallel dispatch.
    const callA = anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: r1ItemA,
      p_direction: 1,
      p_allow_negative: false,
    });
    const callB = anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: r1ItemB,
      p_direction: 1,
      p_allow_negative: false,
    });
    const [resA, resB] = await Promise.allSettled([callA, callB]);

    // supabase-js resolves { data, error } rather than rejecting the promise,
    // so both settle as 'fulfilled' — the race is decided by which .error is null.
    expect(resA.status).toBe('fulfilled');
    expect(resB.status).toBe('fulfilled');
    const errA = resA.status === 'fulfilled' ? (resA.value as { error: { message: string } | null }).error : null;
    const errB = resB.status === 'fulfilled' ? (resB.value as { error: { message: string } | null }).error : null;
    const errors = [errA, errB];
    expect(errors.filter(e => e === null)).toHaveLength(1);
    const failure = errors.find(e => e !== null);
    expect(failure?.message ?? '').toMatch(/INVENTORY_NEGATIVE/i);

    const { data: unitsAfter, error: unitsAfterErr } = await db
      .from('open_units')
      .select('id, status, remaining_count')
      .eq('product_id', r1BoxId);
    expect(unitsAfterErr).toBeNull();
    // Exactly one open_units row exists — the loser's auto-open attempt never created a duplicate.
    expect(unitsAfter).toHaveLength(1);
    const finalUnit = (unitsAfter as { id: string; status: string; remaining_count: number }[])[0]!;
    expect(finalUnit.id).toBe(r1UnitId);
    expect(finalUnit.remaining_count).toBe(0); // never negative
    expect(finalUnit.status).toBe('exhausted');
  });

  it('R2: a quantity-3 line crosses a unit boundary in one atomic call (SC-2, Pitfall 3)', async () => {
    const { boxId: r2BoxId, looseId: r2LooseId } = await createBoxLoosePair({
      unitsPerPackage: 20,
      boxStock: 1, // exactly one fresh package available for the auto-transition
    });
    const r2OriginalUnitId = await seedActiveUnit(r2BoxId, 1);

    const r2Item = await insertLooseOrderItem(r2LooseId, 3);

    const { error: sellErr } = await anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: r2Item,
      p_direction: 1,
      p_allow_negative: false,
    });
    expect(sellErr).toBeNull();

    const { data: units, error: unitsErr } = await db
      .from('open_units')
      .select('id, status, remaining_count')
      .eq('product_id', r2BoxId);
    expect(unitsErr).toBeNull();
    expect(units).toHaveLength(2);

    const typedUnits = units as { id: string; status: string; remaining_count: number }[];
    for (const u of typedUnits) {
      expect(u.remaining_count).toBeGreaterThanOrEqual(0); // never negative on any row
    }

    const original = typedUnits.find(u => u.id === r2OriginalUnitId)!;
    expect(original.status).toBe('exhausted');
    expect(original.remaining_count).toBe(0);

    const fresh = typedUnits.find(u => u.id !== r2OriginalUnitId)!;
    expect(fresh.status).toBe('active');
    expect(fresh.remaining_count).toBe(18); // 20 minus the 2 carried over from the exhausted unit

    // Exactly one row is 'active' afterwards — the auto-transition never leaves two.
    expect(typedUnits.filter(u => u.status === 'active')).toHaveLength(1);

    const { data: inv, error: invErr } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', r2BoxId)
      .single();
    expect(invErr).toBeNull();
    expect((inv as { quantity_on_hand: number }).quantity_on_hand).toBe(0);
  });

  it('R3: exhaustion with zero packages rejects the sale, and p_allow_negative bypasses it through the shared chokepoint (D-05)', async () => {
    const { boxId: r3BoxId, looseId: r3LooseId } = await createBoxLoosePair({
      unitsPerPackage: 20,
      boxStock: 0,
    });

    // No active unit, no package stock — the sale must be rejected.
    const r3ItemReject = await insertLooseOrderItem(r3LooseId, 1);
    const { error: rejectErr } = await anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: r3ItemReject,
      p_direction: 1,
      p_allow_negative: false,
    });
    expect(rejectErr).not.toBeNull();
    expect(rejectErr?.message ?? '').toMatch(/INVENTORY_NEGATIVE/i);

    const { data: unitsAfterReject, error: unitsAfterRejectErr } = await db
      .from('open_units')
      .select('id')
      .eq('product_id', r3BoxId);
    expect(unitsAfterRejectErr).toBeNull();
    expect(unitsAfterReject).toHaveLength(0); // no unit created on the failure path

    const { data: invAfterReject, error: invAfterRejectErr } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', r3BoxId)
      .single();
    expect(invAfterRejectErr).toBeNull();
    expect((invAfterReject as { quantity_on_hand: number }).quantity_on_hand).toBe(0);

    // Same shape useOverrideNegativeStock.ts uses after manager PIN approval.
    const r3ItemOverride = await insertLooseOrderItem(r3LooseId, 1);
    const { error: overrideErr } = await anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: r3ItemOverride,
      p_direction: 1,
      p_allow_negative: true,
    });
    expect(overrideErr).toBeNull();

    const { data: unitsAfterOverride, error: unitsAfterOverrideErr } = await db
      .from('open_units')
      .select('id, status')
      .eq('product_id', r3BoxId);
    expect(unitsAfterOverrideErr).toBeNull();
    expect(unitsAfterOverride).toHaveLength(1);
    const overrideUnit = (unitsAfterOverride as { id: string; status: string }[])[0]!;
    expect(overrideUnit.status).toBe('active');

    const { data: overrideAudit, error: overrideAuditErr } = await db
      .from('audit_logs')
      .select('id')
      .eq('entity_type', 'open_unit')
      .eq('entity_id', overrideUnit.id)
      .eq('action', 'open_unit.override');
    expect(overrideAuditErr).toBeNull();
    expect((overrideAudit as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('R4: refund credit-back caps at units_per_package, and a discarded credit with no active unit is audit-logged, never silent (T-27-08)', async () => {
    const { boxId: r4BoxId, looseId: r4LooseId } = await createBoxLoosePair({
      unitsPerPackage: 20,
      boxStock: 0, // irrelevant to the refund path — never touched by p_direction=-1
    });
    const r4UnitId = await seedActiveUnit(r4BoxId, 5);

    // Sub-case 1: plain credit-back, well under the cap.
    const r4RefundItemA = await insertLooseOrderItem(r4LooseId, 2);
    const { error: refundAErr } = await anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: r4RefundItemA,
      p_direction: -1,
      p_allow_negative: false,
    });
    expect(refundAErr).toBeNull();

    const { data: afterRefundA, error: afterRefundAErr } = await db
      .from('open_units')
      .select('remaining_count')
      .eq('id', r4UnitId)
      .single();
    expect(afterRefundAErr).toBeNull();
    expect((afterRefundA as { remaining_count: number }).remaining_count).toBe(7);

    // Sub-case 2: refund would overshoot units_per_package (19 + 3 = 22) — must cap at 20.
    const { error: reseedErr } = await db
      .from('open_units')
      .update({ remaining_count: 19 })
      .eq('id', r4UnitId);
    expect(reseedErr).toBeNull();

    const r4RefundItemB = await insertLooseOrderItem(r4LooseId, 3);
    const { error: refundBErr } = await anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: r4RefundItemB,
      p_direction: -1,
      p_allow_negative: false,
    });
    expect(refundBErr).toBeNull();

    const { data: afterRefundB, error: afterRefundBErr } = await db
      .from('open_units')
      .select('remaining_count')
      .eq('id', r4UnitId)
      .single();
    expect(afterRefundBErr).toBeNull();
    expect((afterRefundB as { remaining_count: number }).remaining_count).toBe(20); // capped, not 22

    // Sub-case 3: the unit is now exhausted — a refund must discard the credit
    // rather than resurrect it, and the write-off must still be audit-logged.
    const { error: exhaustErr } = await db
      .from('open_units')
      .update({ status: 'exhausted', remaining_count: 0 })
      .eq('id', r4UnitId);
    expect(exhaustErr).toBeNull();

    const { data: invBefore } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', r4BoxId)
      .single();

    const r4RefundItemC = await insertLooseOrderItem(r4LooseId, 1);
    const { error: refundCErr } = await anonClient.rpc('deplete_for_order_item', {
      p_order_item_id: r4RefundItemC,
      p_direction: -1,
      p_allow_negative: false,
    });
    expect(refundCErr).toBeNull();

    const { data: unitsAfterDiscard, error: unitsAfterDiscardErr } = await db
      .from('open_units')
      .select('id, status, remaining_count')
      .eq('product_id', r4BoxId);
    expect(unitsAfterDiscardErr).toBeNull();
    expect(unitsAfterDiscard).toHaveLength(1); // no new unit created
    const discardUnit = (unitsAfterDiscard as { id: string; status: string; remaining_count: number }[])[0]!;
    expect(discardUnit.status).toBe('exhausted'); // never flips back to active
    expect(discardUnit.remaining_count).toBe(0);

    const { data: invAfter } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', r4BoxId)
      .single();
    expect((invAfter as { quantity_on_hand: number }).quantity_on_hand).toBe(
      (invBefore as { quantity_on_hand: number }).quantity_on_hand,
    ); // package stock unchanged

    // record_audit's write-off payload is passed as p_after (5th positional
    // arg), landing in the audit_logs.after column — there is no "details" column.
    const { data: discardAudit, error: discardAuditErr } = await db
      .from('audit_logs')
      .select('after')
      .eq('entity_type', 'open_unit')
      .eq('action', 'open_unit.deplete')
      .is('entity_id', null);
    expect(discardAuditErr).toBeNull();
    const matching = (
      discardAudit as { after: { order_item_id?: string; credit_discarded?: number } | null }[]
    ).filter(row => row.after?.order_item_id === r4RefundItemC);
    expect(matching.length).toBeGreaterThanOrEqual(1); // the write-off is logged, not silent
    expect(matching[0]?.after?.credit_discarded).toBe(1);
  });

  it('Audit coverage: every open_unit.* lifecycle action produced above reached audit_logs with entity_type/source/actor set (SC-4)', async () => {
    const requiredActions = ['open_unit.open', 'open_unit.deplete', 'open_unit.exhaust', 'open_unit.override'];

    for (const action of requiredActions) {
      // ORDER BY created_at DESC is required here: this is a shared live
      // database that accumulates audit_logs rows across every test run ever
      // executed against it (some 'open_unit.deplete' write-off rows have
      // entity_id=NULL — e.g. R4's discarded-credit path above — so they can
      // never be matched/cleaned up by any FK-based afterAll teardown).
      // Without an explicit order, .limit(1) can nondeterministically surface
      // an arbitrary historical row instead of one this run just created.
      const { data, error } = await db
        .from('audit_logs')
        .select('source, actor_id')
        .eq('entity_type', 'open_unit')
        .eq('action', action)
        .order('created_at', { ascending: false })
        .limit(1);
      expect(error).toBeNull();
      expect((data as unknown[]).length).toBeGreaterThanOrEqual(1);
      const row = (data as { source: string; actor_id: string | null }[])[0]!;
      expect(row.source).toBe('rpc');
      expect(row.actor_id).not.toBeNull();
    }
  });
});
