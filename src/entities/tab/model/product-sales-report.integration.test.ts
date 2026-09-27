// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { randomUUID } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { useProductSalesReport } from './queries-reports';

let staffId: string;
let authUserId: string;

// Deterministic test IDs — unique prefix IT-PRSALES to avoid collisions
const IT_SHIFT_ID = 'a1a10000-a1a1-4a1a-8a1a-a1a100000001';
const IT_CAJA_ID = 'b2b20000-b2b2-4b2b-8b2b-b2b200000002';
const IT_TAB_IN_RANGE = 'c3c30000-c3c3-4c3c-8c3c-c3c300000003';
const IT_TAB_OUT_OF_RANGE = 'd4d40000-d4d4-4d4d-8d4d-d4d400000004';
const IT_ORDER_BEER = 'e5e50000-e5e5-4e5e-8e5e-e5e500000005';
const IT_ORDER_SPIRITS = 'f6f60000-f6f6-4f6f-8f6f-f6f600000006';
const IT_ORDER_VOIDED = '17170000-1717-4171-8171-171700000007';
const IT_ORDER_OUT_OF_RANGE = '28280000-2828-4282-8282-282800000008';
const IT_ITEM_BEER_A = '39390000-3939-4393-8393-393900000009';
const IT_ITEM_BEER_B = '4a4a0000-4a4a-4a4a-84a4-4a4a0000000a';
const IT_ITEM_SPIRITS = '5b5b0000-5b5b-4b5b-85b5-5b5b0000000b';
const IT_ITEM_VOIDED = '6c6c0000-6c6c-4c6c-86c6-6c6c0000000c';
const IT_ITEM_OUT_OF_RANGE = '7d7d0000-7d7d-4d7d-87d7-7d7d0000000d';
const REPORT_DATE = '2099-01-01T12:00:00.000Z';

let PRODUCT_ID_BEER: string;
let PRODUCT_ID_SPIRITS: string;

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function reportDateRange() {
  return {
    from: new Date('2099-01-01T00:00:00.000Z'),
    to: new Date('2099-01-01T23:59:59.999Z'),
  };
}

// ---------------------------------------------------------------------------
// Integration: useProductSalesReport — real Supabase
// QA-written tests per AC-2, AC-4, AC-5 of POS-3
// ---------------------------------------------------------------------------

describe('useProductSalesReport — integration (real Supabase)', () => {
  beforeAll(async () => {
    const email = `product-sales-report-${randomUUID()}@test.local`;
    const password = 'Test123456!';
    const { data: authUser, error: authError } = await testDb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    authUserId = authUser.user.id;
    staffId = authUserId;
    const { error: profileError } = await testDb.from('profiles').insert({
      id: staffId,
      name: 'Product Sales Integration',
      email,
      pin: '123456',
      role: 'admin',
    });
    if (profileError) throw new Error(profileError.message);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(signInError.message);

    // Look up Budweiser as the primary test product
    const { data: beer } = await testDb
      .from('products')
      .select('id')
      .eq('name', 'Budweiser')
      .maybeSingle();
    if (!beer?.id) throw new Error('Budweiser product missing — run npm run setup:dev');
    PRODUCT_ID_BEER = beer.id;

    // Use any other product for the second-product aggregation test
    const { data: spirits } = await testDb
      .from('products')
      .select('id')
      .neq('id', PRODUCT_ID_BEER)
      .limit(1)
      .maybeSingle();
    if (!spirits?.id) throw new Error('Need at least 2 products — run npm run setup:dev');
    PRODUCT_ID_SPIRITS = spirits.id;
  });

  afterAll(async () => {
    await supabase.auth.signOut();
    await testDb.auth.admin.deleteUser(authUserId);
  });

  beforeEach(async () => {
    // Defensive cleanup: E2E runs (e.g. KDS Playwright specs) occasionally
    // leak tabs with today's created_at. The product sales query filters by
    // tab.created_at, so those rows inflate revenue totals. Remove them first
    // so this test is resilient to prior-run leftovers.
    const { data: leakedTabs } = await testDb
      .from('tabs')
      .select('id')
      .like('customer_name', 'KDS E2E Tab%');
    const leakedTabIds = (leakedTabs ?? []).map(t => t.id);
    if (leakedTabIds.length > 0) {
      const { data: leakedOrders } = await testDb
        .from('orders')
        .select('id')
        .in('tab_id', leakedTabIds);
      const leakedOrderIds = (leakedOrders ?? []).map(o => o.id);
      if (leakedOrderIds.length > 0) {
        await testDb.from('order_items').delete().in('order_id', leakedOrderIds);
        await testDb.from('orders').delete().in('id', leakedOrderIds);
      }
      await testDb.from('tabs').delete().in('id', leakedTabIds);
    }

    // Seed shift (required FK for tabs)
    const shiftR = await testDb.from('shifts').upsert({
      id: IT_SHIFT_ID,
      staff_id: staffId,
      opening_cash: 0,
      clock_in: new Date().toISOString(),
    });
    if (shiftR.error) throw new Error(`beforeEach shift: ${JSON.stringify(shiftR.error)}`);

    // Seed caja session as 'closed' — we only need a valid FK for tabs.
    // Using 'open' would conflict with the unique_open constraint when running
    // alongside pending-total.integration.test.ts in parallel.
    const cajaR = await testDb.from('caja_sessions').upsert({
      id: IT_CAJA_ID,
      opened_by: staffId,
      opening_cash: 0,
      closing_cash: 0,
      status: 'closed',
      closed_at: new Date().toISOString(),
    });
    if (cajaR.error) throw new Error(`beforeEach caja: ${JSON.stringify(cajaR.error)}`);

    // Use a fixed future day so other tests' current-day sales cannot affect this fixture.
    const tabsR = await testDb.from('tabs').upsert([
      {
        id: IT_TAB_IN_RANGE,
        caja_session_id: IT_CAJA_ID,
        staff_id: staffId,
        shift_id: IT_SHIFT_ID,
        status: 'open',
        customer_name: 'IT-prsales-in-range',
        created_at: REPORT_DATE,
      },
      {
        id: IT_TAB_OUT_OF_RANGE,
        caja_session_id: IT_CAJA_ID,
        staff_id: staffId,
        shift_id: IT_SHIFT_ID,
        status: 'closed',
        closed_at: new Date().toISOString(),
        customer_name: 'IT-prsales-out-of-range',
        created_at: '2020-01-01T12:00:00.000Z',
      },
    ]);
    if (tabsR.error) throw new Error(`beforeEach tabs: ${JSON.stringify(tabsR.error)}`);

    // Seed orders (both belong to in-range tab; one is voided; one belongs to out-of-range tab)
    const ordersR = await testDb.from('orders').upsert([
      { id: IT_ORDER_BEER, tab_id: IT_TAB_IN_RANGE, staff_id: staffId, status: 'pending' },
      { id: IT_ORDER_SPIRITS, tab_id: IT_TAB_IN_RANGE, staff_id: staffId, status: 'pending' },
      { id: IT_ORDER_VOIDED, tab_id: IT_TAB_IN_RANGE, staff_id: staffId, status: 'voided' },
      {
        id: IT_ORDER_OUT_OF_RANGE,
        tab_id: IT_TAB_OUT_OF_RANGE,
        staff_id: staffId,
        status: 'pending',
      },
    ]);
    if (ordersR.error) throw new Error(`beforeEach orders: ${JSON.stringify(ordersR.error)}`);

    // Seed order items:
    //   Beer  (in-range): 2×$10 + 3×$10 = $50 (across two line items, same product)
    //   Spirits (in-range): 1×$30 = $30
    //   Voided beer: 1×$200 — MUST be excluded (order.status = 'voided')
    //   Out-of-range beer: 1×$500 — MUST be excluded (tab.created_at = 2020)
    const itemsR = await testDb.from('order_items').upsert([
      {
        id: IT_ITEM_BEER_A,
        order_id: IT_ORDER_BEER,
        product_id: PRODUCT_ID_BEER,
        quantity: 2,
        unit_price: 10,
        modifier_price_delta: 0,
        cost_price_snapshot: 4,
      },
      {
        id: IT_ITEM_BEER_B,
        order_id: IT_ORDER_BEER,
        product_id: PRODUCT_ID_BEER,
        quantity: 3,
        unit_price: 10,
        modifier_price_delta: 0,
        cost_price_snapshot: null,
      },
      {
        id: IT_ITEM_SPIRITS,
        order_id: IT_ORDER_SPIRITS,
        product_id: PRODUCT_ID_SPIRITS,
        quantity: 1,
        unit_price: 30,
        modifier_price_delta: 0,
        cost_price_snapshot: 20,
      },
      {
        id: IT_ITEM_VOIDED,
        order_id: IT_ORDER_VOIDED,
        product_id: PRODUCT_ID_BEER,
        quantity: 1,
        unit_price: 200,
        modifier_price_delta: 0,
      },
      {
        id: IT_ITEM_OUT_OF_RANGE,
        order_id: IT_ORDER_OUT_OF_RANGE,
        product_id: PRODUCT_ID_BEER,
        quantity: 1,
        unit_price: 500,
        modifier_price_delta: 0,
      },
    ]);
    if (itemsR.error) throw new Error(`beforeEach items: ${JSON.stringify(itemsR.error)}`);
  });

  afterEach(async () => {
    // Delete in FK order: order_items → orders → tabs → caja_sessions → shifts
    await testDb
      .from('order_items')
      .delete()
      .in('id', [
        IT_ITEM_BEER_A,
        IT_ITEM_BEER_B,
        IT_ITEM_SPIRITS,
        IT_ITEM_VOIDED,
        IT_ITEM_OUT_OF_RANGE,
      ]);
    await testDb
      .from('orders')
      .delete()
      .in('id', [IT_ORDER_BEER, IT_ORDER_SPIRITS, IT_ORDER_VOIDED, IT_ORDER_OUT_OF_RANGE]);
    await testDb.from('tabs').delete().in('id', [IT_TAB_IN_RANGE, IT_TAB_OUT_OF_RANGE]);
    await testDb.from('caja_sessions').delete().eq('id', IT_CAJA_ID);
    await testDb.from('shifts').delete().eq('id', IT_SHIFT_ID);
  });

  // -------------------------------------------------------------------------
  // AC-5: aggregation query over seeded fixture with multiple products
  // -------------------------------------------------------------------------

  it('AC-5: aggregates order_items by product — beer=$50 (5 units), spirits=$30 (1 unit)', async () => {
    const { from, to } = reportDateRange();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProductSalesReport(from, to), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;

    const rows = result.current.data.data;

    // Beer: two line items for same product (2×$10 + 3×$10) → 5 units, $50 revenue
    const beerRow = rows.find(r => r.productId === PRODUCT_ID_BEER);
    expect(beerRow).toBeDefined();
    expect(beerRow?.units).toBe(5);
    expect(beerRow?.revenue).toBe(50);
    expect(beerRow?.costTotal).toBe(8);
    expect(beerRow?.margin).toBe(12);

    // Spirits: 1×$30 → 1 unit, $30 revenue
    const spiritsRow = rows.find(r => r.productId === PRODUCT_ID_SPIRITS);
    expect(spiritsRow).toBeDefined();
    expect(spiritsRow?.units).toBe(1);
    expect(spiritsRow?.revenue).toBe(30);
    expect(spiritsRow?.costTotal).toBe(20);
    expect(spiritsRow?.margin).toBe(10);

    // Default sort: Beer ($50) before Spirits ($30) — revenue desc
    const beerIdx = rows.findIndex(r => r.productId === PRODUCT_ID_BEER);
    const spiritsIdx = rows.findIndex(r => r.productId === PRODUCT_ID_SPIRITS);
    expect(beerIdx).toBeLessThan(spiritsIdx);

    qc.clear();
  });

  it('AC-5: weighted line applies weight_grams/1000 factor to cost, not just revenue', async () => {
    const IT_ITEM_BEER_WEIGHTED = '8e8e0000-8e8e-4e8e-88e8-8e8e0000000e';
    const weightedItemR = await testDb.from('order_items').insert({
      id: IT_ITEM_BEER_WEIGHTED,
      order_id: IT_ORDER_BEER,
      product_id: PRODUCT_ID_BEER,
      quantity: 1,
      unit_price: 5,
      modifier_price_delta: 0,
      weight_grams: 500,
      cost_price_snapshot: 4,
    });
    if (weightedItemR.error) {
      throw new Error(`weighted fixture insert: ${JSON.stringify(weightedItemR.error)}`);
    }

    try {
      const { from, to } = reportDateRange();

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(() => useProductSalesReport(from, to), {
        wrapper: makeWrapper(qc),
      });

      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true);
        },
        { timeout: 10_000 }
      );

      expect(result.current.data?.ok).toBe(true);
      if (!result.current.data?.ok) return;

      const beerRow = result.current.data.data.find(r => r.productId === PRODUCT_ID_BEER);
      // Existing AC-5 beer fixture: revenue=50, costTotal=8.
      // Weighted line: 500g sale at unit_price=5, cost_price_snapshot=4 → weight-adjusted
      // cost is 4 * 0.5 = $2, NOT the full $4.
      expect(beerRow?.revenue).toBe(55);
      expect(beerRow?.costTotal).toBe(10);
      expect(beerRow?.margin).toBe(15);

      qc.clear();
    } finally {
      await testDb.from('order_items').delete().eq('id', IT_ITEM_BEER_WEIGHTED);
    }
  });

  it('returns null margin totals when every sale has no recorded cost', async () => {
    const update = await testDb
      .from('order_items')
      .update({ cost_price_snapshot: null })
      .eq('id', IT_ITEM_SPIRITS);
    if (update.error) throw new Error(`margin fixture update: ${JSON.stringify(update.error)}`);

    const { from, to } = reportDateRange();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProductSalesReport(from, to), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;

    const spiritsRow = result.current.data.data.find(r => r.productId === PRODUCT_ID_SPIRITS);
    expect(spiritsRow?.costTotal).toBeNull();
    expect(spiritsRow?.margin).toBeNull();
    qc.clear();
  });

  // -------------------------------------------------------------------------
  // AC-2a: voided orders excluded from revenue aggregation
  // -------------------------------------------------------------------------

  it('AC-2: voided order_items are excluded — beer revenue is $50, not $250', async () => {
    const { from, to } = reportDateRange();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProductSalesReport(from, to), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;

    const beerRow = result.current.data.data.find(r => r.productId === PRODUCT_ID_BEER);
    // In-range non-voided: 2×$10 + 3×$10 = $50. Voided order ($200) must be excluded.
    expect(beerRow?.revenue).toBe(50);

    qc.clear();
  });

  // -------------------------------------------------------------------------
  // AC-2b: date range filter excludes tabs whose created_at is outside [from, to]
  // -------------------------------------------------------------------------

  it('AC-2: date range filter excludes tabs from 2020 — beer revenue stays $50', async () => {
    const { from, to } = reportDateRange();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProductSalesReport(from, to), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;

    const beerRow = result.current.data.data.find(r => r.productId === PRODUCT_ID_BEER);
    // Out-of-range tab (created 2020-01-01) had 1×$500 beer item — must be excluded.
    // Revenue must be $50 (in-range items only), not $550.
    expect(beerRow?.revenue).toBe(50);

    qc.clear();
  });

  // -------------------------------------------------------------------------
  // AC-4: empty array returned when date range contains no orders
  // -------------------------------------------------------------------------

  it('AC-4: returns empty array (→ empty state) when date range has no orders', async () => {
    const from = new Date('2020-06-01T00:00:00.000Z');
    const to = new Date('2020-06-01T23:59:59.999Z');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProductSalesReport(from, to), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;
    expect(result.current.data.data).toHaveLength(0);

    qc.clear();
  });

  // -------------------------------------------------------------------------
  // D-06: historical margin unchanged after a restock (ROADMAP Phase 7
  // Success Criterion #2) — regression guard only. order_items already
  // snapshots cost_price at sale time, so this proves the new weighted-avg
  // receive_shipment logic doesn't accidentally break that existing
  // immunity; it does not assert a NEW sale picks up the new cost.
  // -------------------------------------------------------------------------

  it('D-06: receive_shipment does not alter a previously-sold item margin', async () => {
    // suppliers/shipments/receive_shipment are not yet in generated Supabase
    // types (DATA-03's types regen is a separate plan, 07-03, in this
    // phase) — cast per CLAUDE.md's "Missing generated types workaround".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = testDb as any;

    const IT_MARGIN_REGRESSION_PRODUCT = '9f9f0000-9f9f-4f9f-89f9-9f9f0000000f';
    const IT_MARGIN_REGRESSION_SUPPLIER = 'a0a00000-a0a0-4a0a-8a0a-a0a000000010';
    const IT_MARGIN_REGRESSION_ITEM = 'b1b10000-b1b1-4b1b-8b1b-b1b100000011';

    const { data: category } = await testDb.from('categories').select('id').limit(1).maybeSingle();
    if (!category?.id) throw new Error('run npm run setup:dev');

    const supplierR = await db
      .from('suppliers')
      .insert({ id: IT_MARGIN_REGRESSION_SUPPLIER, name: 'IT Margin Regression Supplier' });
    if (supplierR.error) throw new Error(`supplier seed: ${JSON.stringify(supplierR.error)}`);

    const productR = await testDb.from('products').insert({
      id: IT_MARGIN_REGRESSION_PRODUCT,
      name: 'IT Margin Regression Product',
      category_id: category.id,
      base_price: 20,
      is_active: true,
      sold_by_weight: false,
    });
    if (productR.error) throw new Error(`product seed: ${JSON.stringify(productR.error)}`);

    try {
      const itemR = await testDb.from('order_items').insert({
        id: IT_MARGIN_REGRESSION_ITEM,
        order_id: IT_ORDER_BEER,
        product_id: IT_MARGIN_REGRESSION_PRODUCT,
        quantity: 1,
        unit_price: 20,
        modifier_price_delta: 0,
        cost_price_snapshot: 5,
      });
      if (itemR.error) throw new Error(`order_items seed: ${JSON.stringify(itemR.error)}`);

      const { from, to } = reportDateRange();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      const before = renderHook(() => useProductSalesReport(from, to), { wrapper: makeWrapper(qc) });
      await waitFor(() => {
        expect(before.result.current.isSuccess).toBe(true);
      }, { timeout: 10_000 });
      expect(before.result.current.data?.ok).toBe(true);
      if (!before.result.current.data?.ok) return;
      const beforeRow = before.result.current.data.data.find(
        r => r.productId === IT_MARGIN_REGRESSION_PRODUCT
      );
      expect(beforeRow).toBeDefined();

      // cost_price=50 is deliberately far from the snapshot's 5, so any
      // accidental live-cost read would be obviously visible below.
      const receiveR = await db.rpc('receive_shipment', {
        p_staff_id: staffId,
        p_supplier_id: IT_MARGIN_REGRESSION_SUPPLIER,
        p_items: [
          { product_id: IT_MARGIN_REGRESSION_PRODUCT, quantity: 10, cost_price: 50, expiry_date: null },
        ],
      });
      expect(receiveR.error).toBeNull();
      expect(receiveR.data?.ok).toBe(true);

      const after = renderHook(() => useProductSalesReport(from, to), { wrapper: makeWrapper(qc) });
      await waitFor(() => {
        expect(after.result.current.isSuccess).toBe(true);
      }, { timeout: 10_000 });
      expect(after.result.current.data?.ok).toBe(true);
      if (!after.result.current.data?.ok) return;
      const afterRow = after.result.current.data.data.find(
        r => r.productId === IT_MARGIN_REGRESSION_PRODUCT
      );
      expect(afterRow).toBeDefined();

      expect(afterRow?.margin).toBe(beforeRow?.margin);
      expect(afterRow?.costTotal).toBe(beforeRow?.costTotal);
      expect(afterRow?.revenue).toBe(beforeRow?.revenue);

      qc.clear();
    } finally {
      await testDb.from('order_items').delete().eq('id', IT_MARGIN_REGRESSION_ITEM);
      await db.from('stock_movements').delete().eq('product_id', IT_MARGIN_REGRESSION_PRODUCT);
      await db.from('inventory').delete().eq('product_id', IT_MARGIN_REGRESSION_PRODUCT);
      await db.from('shipments').delete().eq('supplier_id', IT_MARGIN_REGRESSION_SUPPLIER);
      await testDb.from('products').delete().eq('id', IT_MARGIN_REGRESSION_PRODUCT);
      await db.from('suppliers').delete().eq('id', IT_MARGIN_REGRESSION_SUPPLIER);
    }
  });
});
