import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test for Phase 27 (27-04) — the three manual lifecycle RPCs the
 * admin Open-Units tab drives: open_open_unit (bartender+, D-11),
 * correct_open_unit / void_open_unit (manager+, D-12).
 *
 * Requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and
 * SUPABASE_SERVICE_ROLE_KEY in environment (describe.skipIf below).
 *
 * Mirrors consume-open-unit.integration.test.ts's fixture-and-teardown
 * skeleton (27-02), but creates TWO temporary auth users — one with a
 * bartender profile role and one with a manager profile role — because this
 * plan's whole point is proving the RBAC split between the two tiers holds
 * at the function body, not just at the client-side ManagerPinDialog
 * (T-27-09, the process_refund precedent). All escalation assertions below
 * use the bartender client, never the service-role client, which bypasses
 * RLS/guards entirely and would prove nothing about the guard.
 *
 * NOTE: this file is authored and committed per plan 27-04, but is NOT
 * executed in this session — running it requires migration 20260729000005
 * to already be pushed to the live remote Supabase project, which is
 * deliberately deferred to a human-reviewed follow-up (see 27-04-SUMMARY.md
 * "Deferred to Human Review", mirroring 27-02's checkpoint).
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
const skip = !url || !serviceKey || !anonKey;

describe.skipIf(skip)('open_unit lifecycle RPCs integration (Phase 27 27-04)', () => {
  // Service-role client: setup, teardown, direct table reads (bypasses RLS).
  // persistSession/autoRefreshToken disabled so this client's Authorization
  // header cannot be silently swapped to either signed-in client's session
  // (both clients otherwise share the same default GoTrueClient storage key
  // against this project URL) — see 27-02-SUMMARY.md's Rule-1 fix and
  // locale-rls.integration.test.ts for the same pattern.
  const db = createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
  // Bartender-role authenticated client: exercises D-11's allowed path and
  // D-12's escalation-rejection path.
  const bartenderClient = createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
  // Manager-role authenticated client: exercises D-12's allowed path.
  const managerClient = createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;

  let bartenderUserId: string;
  let managerUserId: string;
  let categoryId: string;
  let boxProductId: string;
  let looseProductId: string;
  let shiftId: string;
  let tabId: string;
  let orderId: string;
  let saleItemId: string;

  // Shared across tests — the single open_units row created in the first
  // test and mutated (corrected, then voided) by later tests in sequence.
  let unitId: string;

  const BOX_UNITS_PER_PACKAGE = 20;
  const BOX_INITIAL_STOCK = 3;
  const BOX_BASE_PRICE = 100.0;
  const LOOSE_BASE_PRICE = 7.5;

  beforeAll(async () => {
    // Two temporary test users, signed in so each client carries a distinct
    // auth.uid() with a distinct profiles.role.
    const bartenderEmail = `__open_unit_lifecycle_bartender_${Date.now()}@test.local`;
    const managerEmail = `__open_unit_lifecycle_manager_${Date.now()}@test.local`;
    const password = 'TestOpenUnitLifecycle123!';

    const { data: bartenderAuth, error: bartenderCreateErr } = await db.auth.admin.createUser({
      email: bartenderEmail,
      password,
      email_confirm: true,
    });
    if (bartenderCreateErr || !bartenderAuth.user) {
      throw new Error(`bartender user create: ${bartenderCreateErr?.message}`);
    }
    bartenderUserId = bartenderAuth.user.id;

    const { data: managerAuth, error: managerCreateErr } = await db.auth.admin.createUser({
      email: managerEmail,
      password,
      email_confirm: true,
    });
    if (managerCreateErr || !managerAuth.user) {
      throw new Error(`manager user create: ${managerCreateErr?.message}`);
    }
    managerUserId = managerAuth.user.id;

    const { error: bartenderProfileErr } = await db.from('profiles').upsert({
      id: bartenderUserId,
      name: '__open_unit_lifecycle_bartender__',
      email: bartenderEmail,
      role: 'cashier',
      pin: '999997',
      is_active: true,
    });
    if (bartenderProfileErr) throw new Error(`bartender profile upsert: ${bartenderProfileErr.message}`);

    const { error: managerProfileErr } = await db.from('profiles').upsert({
      id: managerUserId,
      name: '__open_unit_lifecycle_manager__',
      email: managerEmail,
      role: 'manager',
      pin: '999996',
      is_active: true,
    });
    if (managerProfileErr) throw new Error(`manager profile upsert: ${managerProfileErr.message}`);

    const { error: bartenderSignInErr } = await bartenderClient.auth.signInWithPassword({
      email: bartenderEmail,
      password,
    });
    if (bartenderSignInErr) throw new Error(`bartender sign in: ${bartenderSignInErr.message}`);

    const { error: managerSignInErr } = await managerClient.auth.signInWithPassword({
      email: managerEmail,
      password,
    });
    if (managerSignInErr) throw new Error(`manager sign in: ${managerSignInErr.message}`);

    // Category
    const { data: cat, error: catErr } = await db.from('categories').select('id').limit(1).single();
    if (catErr || !cat) throw new Error(`category lookup: ${catErr?.message ?? 'no categories'}`);
    categoryId = (cat as { id: string }).id;

    // BOX product (units_per_package = 20)
    const { data: boxProd, error: boxErr } = await db
      .from('products')
      .insert({
        name: '__test_open_unit_lifecycle_box__',
        base_price: BOX_BASE_PRICE,
        category_id: categoryId,
        is_active: true,
        units_per_package: BOX_UNITS_PER_PACKAGE,
      })
      .select('id')
      .single();
    if (boxErr) throw new Error(`box product insert: ${boxErr.message}`);
    boxProductId = (boxProd as { id: string }).id;

    // inventory row for the BOX product
    const { error: invErr } = await db
      .from('inventory')
      .insert({ product_id: boxProductId, quantity_on_hand: BOX_INITIAL_STOCK });
    if (invErr) throw new Error(`inventory insert: ${invErr.message}`);

    // LOOSE product, linked to the BOX — only needed for the "sale doesn't
    // resurrect a voided unit" assertion.
    const { data: looseProd, error: looseErr } = await db
      .from('products')
      .insert({
        name: '__test_open_unit_lifecycle_loose__',
        base_price: LOOSE_BASE_PRICE,
        category_id: categoryId,
        is_active: true,
        parent_product_id: boxProductId,
      })
      .select('id')
      .single();
    if (looseErr) throw new Error(`loose product insert: ${looseErr.message}`);
    looseProductId = (looseProd as { id: string }).id;

    // Tab + order + order_item (staff = bartender test user) for the sale test.
    const { data: newShift, error: shiftErr } = await db
      .from('shifts')
      .insert({ staff_id: bartenderUserId, opening_cash: 0 })
      .select('id')
      .single();
    if (shiftErr || !newShift) throw new Error(`shift insert: ${shiftErr?.message}`);
    shiftId = (newShift as { id: string }).id;

    const { data: tab, error: tabErr } = await db
      .from('tabs')
      .insert({
        customer_name: '__test_open_unit_lifecycle_tab__',
        status: 'open',
        is_deleted: false,
        staff_id: bartenderUserId,
        shift_id: shiftId,
      })
      .select('id')
      .single();
    if (tabErr) throw new Error(`tab insert: ${tabErr.message}`);
    tabId = (tab as { id: string }).id;

    const { data: order, error: orderErr } = await db
      .from('orders')
      .insert({ tab_id: tabId, status: 'pending', staff_id: bartenderUserId })
      .select('id')
      .single();
    if (orderErr) throw new Error(`order insert: ${orderErr.message}`);
    orderId = (order as { id: string }).id;

    const { data: item, error: itemErr } = await db
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
    if (itemErr) throw new Error(`order_item insert: ${itemErr.message}`);
    saleItemId = (item as { id: string }).id;
  });

  afterAll(async () => {
    await bartenderClient.auth.signOut();
    await managerClient.auth.signOut();

    // Cleanup audit_logs / open_units referencing the BOX product first (FK-safe order)
    if (boxProductId) {
      const { data: units } = await db.from('open_units').select('id').eq('product_id', boxProductId);
      const unitIds = ((units as { id: string }[] | null) ?? []).map(u => u.id);
      if (unitIds.length > 0) {
        await db.from('audit_logs').delete().in('entity_id', unitIds);
        await db.from('open_units').delete().in('id', unitIds);
      }
    }

    if (saleItemId) await db.from('order_items').delete().eq('id', saleItemId);
    if (orderId) await db.from('orders').delete().eq('id', orderId);
    if (tabId) await db.from('tabs').delete().eq('id', tabId);
    if (shiftId) await db.from('shifts').delete().eq('id', shiftId);
    if (looseProductId) await db.from('products').delete().eq('id', looseProductId);
    if (boxProductId) {
      await db.from('inventory').delete().eq('product_id', boxProductId);
      await db.from('products').delete().eq('id', boxProductId);
    }

    if (bartenderUserId) {
      await db.from('profiles').delete().eq('id', bartenderUserId);
      await db.auth.admin.deleteUser(bartenderUserId);
    }
    if (managerUserId) {
      await db.from('profiles').delete().eq('id', managerUserId);
      await db.auth.admin.deleteUser(managerUserId);
    }
  });

  it('D-11/SC-3: a bartender can open a new unit, recording who/when and decrementing package stock', async () => {
    const { data, error } = await bartenderClient.rpc('open_open_unit', { p_product_id: boxProductId });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    unitId = data as string;

    const { data: unit, error: unitErr } = await db
      .from('open_units')
      .select('status, remaining_count, opened_by, opened_at')
      .eq('id', unitId)
      .single();
    expect(unitErr).toBeNull();
    expect((unit as { status: string }).status).toBe('active');
    expect((unit as { remaining_count: number }).remaining_count).toBe(BOX_UNITS_PER_PACKAGE);
    expect((unit as { opened_by: string }).opened_by).toBe(bartenderUserId);
    expect((unit as { opened_at: string | null }).opened_at).not.toBeNull();

    const { data: inv, error: invErr } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', boxProductId)
      .single();
    expect(invErr).toBeNull();
    expect((inv as { quantity_on_hand: number }).quantity_on_hand).toBe(BOX_INITIAL_STOCK - 1);

    const { data: auditRows, error: auditErr } = await db
      .from('audit_logs')
      .select('action, source, actor_id')
      .eq('entity_type', 'open_unit')
      .eq('entity_id', unitId);
    expect(auditErr).toBeNull();
    const rows = auditRows as { action: string; source: string; actor_id: string | null }[];
    expect(rows.some(r => r.action === 'open_unit.open')).toBe(true);
    for (const row of rows) {
      expect(row.source).toBe('rpc');
      expect(row.actor_id).not.toBeNull();
    }
  });

  it('D-07/D-08: opening a second unit for the same product is rejected with the live remaining count, and consumes no package', async () => {
    const { error } = await bartenderClient.rpc('open_open_unit', { p_product_id: boxProductId });
    expect(error).not.toBeNull();
    expect(error.message).toContain(String(BOX_UNITS_PER_PACKAGE));

    const { data: units, error: unitsErr } = await db
      .from('open_units')
      .select('id')
      .eq('product_id', boxProductId);
    expect(unitsErr).toBeNull();
    expect(units).toHaveLength(1);

    const { data: inv, error: invErr } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', boxProductId)
      .single();
    expect(invErr).toBeNull();
    expect((inv as { quantity_on_hand: number }).quantity_on_hand).toBe(BOX_INITIAL_STOCK - 1);
  });

  it('D-12/T-27-09: a bartender calling correct_open_unit or void_open_unit directly is rejected at the function body', async () => {
    const { error: correctErr } = await bartenderClient.rpc('correct_open_unit', {
      p_open_unit_id: unitId,
      p_remaining_count: 5,
      p_reason: 'miscount',
    });
    expect(correctErr).not.toBeNull();
    expect(correctErr.message).toContain('AUTH_FORBIDDEN');

    const { error: voidErr } = await bartenderClient.rpc('void_open_unit', {
      p_open_unit_id: unitId,
      p_reason: 'damaged',
    });
    expect(voidErr).not.toBeNull();
    expect(voidErr.message).toContain('AUTH_FORBIDDEN');

    const { data: unit, error: unitErr } = await db
      .from('open_units')
      .select('status, remaining_count')
      .eq('id', unitId)
      .single();
    expect(unitErr).toBeNull();
    expect((unit as { status: string }).status).toBe('active');
    expect((unit as { remaining_count: number }).remaining_count).toBe(BOX_UNITS_PER_PACKAGE);
  });

  it('D-10: a manager can correct the remaining count, with both old and new counts recoverable from the audit trail', async () => {
    const { error } = await managerClient.rpc('correct_open_unit', {
      p_open_unit_id: unitId,
      p_remaining_count: 5,
      p_reason: 'physical recount',
    });
    expect(error).toBeNull();

    const { data: unit, error: unitErr } = await db
      .from('open_units')
      .select('remaining_count')
      .eq('id', unitId)
      .single();
    expect(unitErr).toBeNull();
    expect((unit as { remaining_count: number }).remaining_count).toBe(5);

    const { data: auditRows, error: auditErr } = await db
      .from('audit_logs')
      .select('before, after')
      .eq('entity_type', 'open_unit')
      .eq('entity_id', unitId)
      .eq('action', 'open_unit.correct');
    expect(auditErr).toBeNull();
    const rows = auditRows as { before: { remaining_count: number }; after: { remaining_count: number } }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before.remaining_count).toBe(BOX_UNITS_PER_PACKAGE);
    expect(rows[0]!.after.remaining_count).toBe(5);
  });

  it('correction validation: out-of-range counts and a blank reason are all rejected, count stays 5', async () => {
    const { error: tooHighErr } = await managerClient.rpc('correct_open_unit', {
      p_open_unit_id: unitId,
      p_remaining_count: BOX_UNITS_PER_PACKAGE + 1,
      p_reason: 'typo',
    });
    expect(tooHighErr).not.toBeNull();

    const { error: negativeErr } = await managerClient.rpc('correct_open_unit', {
      p_open_unit_id: unitId,
      p_remaining_count: -1,
      p_reason: 'typo',
    });
    expect(negativeErr).not.toBeNull();

    const { error: blankReasonErr } = await managerClient.rpc('correct_open_unit', {
      p_open_unit_id: unitId,
      p_remaining_count: 5,
      p_reason: '',
    });
    expect(blankReasonErr).not.toBeNull();

    const { data: unit, error: unitErr } = await db
      .from('open_units')
      .select('remaining_count')
      .eq('id', unitId)
      .single();
    expect(unitErr).toBeNull();
    expect((unit as { remaining_count: number }).remaining_count).toBe(5);
  });

  it('D-10: a manager can void an active unit early with a reason, without crediting inventory back', async () => {
    const { error } = await managerClient.rpc('void_open_unit', {
      p_open_unit_id: unitId,
      p_reason: 'box damaged',
    });
    expect(error).toBeNull();

    const { data: unit, error: unitErr } = await db
      .from('open_units')
      .select('status, remaining_count, closed_by, closed_reason')
      .eq('id', unitId)
      .single();
    expect(unitErr).toBeNull();
    expect((unit as { status: string }).status).toBe('void');
    expect((unit as { remaining_count: number }).remaining_count).toBe(0);
    expect((unit as { closed_by: string }).closed_by).toBe(managerUserId);
    expect((unit as { closed_reason: string }).closed_reason).toBe('box damaged');

    const { data: inv, error: invErr } = await db
      .from('inventory')
      .select('quantity_on_hand')
      .eq('product_id', boxProductId)
      .single();
    expect(invErr).toBeNull();
    expect((inv as { quantity_on_hand: number }).quantity_on_hand).toBe(BOX_INITIAL_STOCK - 1);

    const { data: auditRows, error: auditErr } = await db
      .from('audit_logs')
      .select('action')
      .eq('entity_type', 'open_unit')
      .eq('entity_id', unitId)
      .eq('action', 'open_unit.void');
    expect(auditErr).toBeNull();
    expect(auditRows).toHaveLength(1);
  });

  it('the freed product accepts a fresh open_open_unit call — the partial unique index released when the unit left active', async () => {
    const { data, error } = await bartenderClient.rpc('open_open_unit', { p_product_id: boxProductId });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    expect(data).not.toBe(unitId);

    const { data: freshUnit, error: freshUnitErr } = await db
      .from('open_units')
      .select('status, remaining_count')
      .eq('id', data as string)
      .single();
    expect(freshUnitErr).toBeNull();
    expect((freshUnit as { status: string }).status).toBe('active');
    expect((freshUnit as { remaining_count: number }).remaining_count).toBe(BOX_UNITS_PER_PACKAGE);
  });

  it('voided units are not consumable: a sale never resurrects the voided row — its count stays 0', async () => {
    // At this point the box product already has a fresh active unit (from
    // the previous test), so this sale decrements that unit rather than
    // auto-opening another — either way, the invariant under test is that
    // the *voided* row (unitId) is untouched.
    const { error: sellErr } = await bartenderClient.rpc('deplete_for_order_item', {
      p_order_item_id: saleItemId,
      p_direction: 1,
      p_allow_negative: false,
    });
    expect(sellErr).toBeNull();

    const { data: voidedUnit, error: voidedUnitErr } = await db
      .from('open_units')
      .select('status, remaining_count')
      .eq('id', unitId)
      .single();
    expect(voidedUnitErr).toBeNull();
    expect((voidedUnit as { status: string }).status).toBe('void');
    expect((voidedUnit as { remaining_count: number }).remaining_count).toBe(0);
  });
});
