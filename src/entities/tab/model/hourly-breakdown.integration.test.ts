// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { useHourlyBreakdown } from './queries-reports';

// Jamie Chen (manager) — same staff used in product-sales integration test
const STAFF_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e';

// Deterministic test IDs — unique prefix IT-HOURLY to avoid collisions
const IT_SHIFT_ID = 'a1110000-a111-4a11-8a11-a11100000001';
const IT_CAJA_ID = 'b2220000-b222-4b22-8b22-b22200000002';
const IT_TAB_IN_RANGE = 'c3330000-c333-4c33-8c33-c33300000003';
const IT_TAB_OUT_OF_RANGE = 'd4440000-d444-4d44-8d44-d44400000004';
const IT_ORDER_HOUR_08 = 'e5550000-e555-4e55-8e55-e55500000005';
const IT_ORDER_HOUR_20 = 'f6660000-f666-4f66-8f66-f66600000006';
const IT_ORDER_VOIDED = '17770000-1777-4177-8177-177700000007';
const IT_ORDER_OUT_OF_RANGE = '28880000-2888-4288-8288-288800000008';
const IT_ITEM_HOUR_08 = '39990000-3999-4399-8399-399900000009';
const IT_ITEM_HOUR_20 = '4aaa0000-4aaa-4aaa-84aa-4aaa0000000a';
const IT_ITEM_VOIDED = '5bbb0000-5bbb-4b5b-85bb-5bbb0000000b';
const IT_ITEM_OUT_OF_RANGE = '6ccc0000-6ccc-4c6c-86cc-6ccc0000000c';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// Helper: build a timestamp for today at a given hour (local time)
function todayAt(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Integration: useHourlyBreakdown — real Supabase
// QA-written tests per AC-1 of POS-7
// ---------------------------------------------------------------------------

describe('useHourlyBreakdown — integration (real Supabase)', () => {
  let PRODUCT_ID: string;

  beforeAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'jamie@barpos.dev', password: '567890' });

    // Pick a product that is NOT Budweiser — the product-sales integration
    // test seeds items against Budweiser, and running the two suites in
    // parallel causes cross-pollution if both aggregate against the same
    // product id. Choosing a different product keeps the two isolated.
    const { data: product } = await testDb
      .from('products')
      .select('id')
      .neq('name', 'Budweiser')
      .limit(1)
      .maybeSingle();
    if (!product?.id) throw new Error('No non-Budweiser product found — run npm run setup:dev');
    PRODUCT_ID = product.id;
  });

  afterAll(async () => {
    await supabase.auth.signOut();
  });

  beforeEach(async () => {
    // Defensive cleanup: E2E test runs (e.g. KDS Playwright specs) occasionally
    // leave tabs/orders/items with today's created_at that have not been cleaned
    // up. Those rows leak into the hourly-breakdown query (which filters purely
    // by tab.created_at) and inflate the revenue. Remove them before seeding so
    // this test is resilient to prior-run leftovers.
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

    // Seed shift
    const shiftR = await testDb.from('shifts').upsert({
      id: IT_SHIFT_ID,
      staff_id: STAFF_ID,
      opening_cash: 0,
      clock_in: new Date().toISOString(),
    });
    if (shiftR.error) throw new Error(`beforeEach shift: ${JSON.stringify(shiftR.error)}`);

    // Seed caja session as 'closed' to avoid unique_open constraint conflicts
    const cajaR = await testDb.from('caja_sessions').upsert({
      id: IT_CAJA_ID,
      opened_by: STAFF_ID,
      opening_cash: 0,
      closing_cash: 0,
      status: 'closed',
      closed_at: new Date().toISOString(),
    });
    if (cajaR.error) throw new Error(`beforeEach caja: ${JSON.stringify(cajaR.error)}`);

    // Seed tabs: one in today's range, one from 2020 (out of range)
    const tabsR = await testDb.from('tabs').upsert([
      {
        id: IT_TAB_IN_RANGE,
        caja_session_id: IT_CAJA_ID,
        staff_id: STAFF_ID,
        shift_id: IT_SHIFT_ID,
        status: 'open',
        customer_name: 'IT-hourly-in-range',
        created_at: new Date().toISOString(),
      },
      {
        id: IT_TAB_OUT_OF_RANGE,
        caja_session_id: IT_CAJA_ID,
        staff_id: STAFF_ID,
        shift_id: IT_SHIFT_ID,
        status: 'closed',
        closed_at: new Date().toISOString(),
        customer_name: 'IT-hourly-out-of-range',
        created_at: '2020-01-01T12:00:00.000Z',
      },
    ]);
    if (tabsR.error) throw new Error(`beforeEach tabs: ${JSON.stringify(tabsR.error)}`);

    // Seed orders with specific created_at hours (hour 8 and hour 20 today),
    // plus a voided order and an out-of-range order
    const ordersR = await testDb.from('orders').upsert([
      {
        id: IT_ORDER_HOUR_08,
        tab_id: IT_TAB_IN_RANGE,
        staff_id: STAFF_ID,
        status: 'pending',
        created_at: todayAt(8),
      },
      {
        id: IT_ORDER_HOUR_20,
        tab_id: IT_TAB_IN_RANGE,
        staff_id: STAFF_ID,
        status: 'pending',
        created_at: todayAt(20),
      },
      {
        id: IT_ORDER_VOIDED,
        tab_id: IT_TAB_IN_RANGE,
        staff_id: STAFF_ID,
        status: 'voided',
        created_at: todayAt(8),
      },
      {
        id: IT_ORDER_OUT_OF_RANGE,
        tab_id: IT_TAB_OUT_OF_RANGE,
        staff_id: STAFF_ID,
        status: 'pending',
        created_at: '2020-01-01T10:00:00.000Z',
      },
    ]);
    if (ordersR.error) throw new Error(`beforeEach orders: ${JSON.stringify(ordersR.error)}`);

    // Top up inventory for PRODUCT_ID so the decrement trigger on order_items
    // never drives quantity_on_hand below zero. Prior crashed runs can leave
    // the inventory drifted; reset it to a safe high value before each test.
    const invR = await testDb
      .from('inventory')
      .upsert({ product_id: PRODUCT_ID, quantity_on_hand: 1000 }, { onConflict: 'product_id' });
    if (invR.error) throw new Error(`beforeEach inventory: ${JSON.stringify(invR.error)}`);

    // Seed items:
    //   Hour 8: 1×$25 = $25
    //   Hour 20: 1×$40 = $40
    //   Voided at hour 8: 1×$999 — must be excluded
    //   Out-of-range: 1×$500 — must be excluded
    const itemsR = await testDb.from('order_items').upsert([
      {
        id: IT_ITEM_HOUR_08,
        order_id: IT_ORDER_HOUR_08,
        product_id: PRODUCT_ID,
        quantity: 1,
        unit_price: 25,
        modifier_price_delta: 0,
      },
      {
        id: IT_ITEM_HOUR_20,
        order_id: IT_ORDER_HOUR_20,
        product_id: PRODUCT_ID,
        quantity: 1,
        unit_price: 40,
        modifier_price_delta: 0,
      },
      {
        id: IT_ITEM_VOIDED,
        order_id: IT_ORDER_VOIDED,
        product_id: PRODUCT_ID,
        quantity: 1,
        unit_price: 999,
        modifier_price_delta: 0,
      },
      {
        id: IT_ITEM_OUT_OF_RANGE,
        order_id: IT_ORDER_OUT_OF_RANGE,
        product_id: PRODUCT_ID,
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
      .in('id', [IT_ITEM_HOUR_08, IT_ITEM_HOUR_20, IT_ITEM_VOIDED, IT_ITEM_OUT_OF_RANGE]);
    await testDb
      .from('orders')
      .delete()
      .in('id', [IT_ORDER_HOUR_08, IT_ORDER_HOUR_20, IT_ORDER_VOIDED, IT_ORDER_OUT_OF_RANGE]);
    await testDb.from('tabs').delete().in('id', [IT_TAB_IN_RANGE, IT_TAB_OUT_OF_RANGE]);
    await testDb.from('caja_sessions').delete().eq('id', IT_CAJA_ID);
    await testDb.from('shifts').delete().eq('id', IT_SHIFT_ID);
  });

  // -------------------------------------------------------------------------
  // AC-1: query returns exactly 24 rows (fillMissingHours fills all hours)
  // -------------------------------------------------------------------------

  it('AC-1: returns exactly 24 rows after fillMissingHours for a day with sparse data', async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHourlyBreakdown(from, to), {
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

    expect(result.current.data.data).toHaveLength(24);
    // Hours 0–23 must all be present
    const hours = result.current.data.data.map(r => r.hour).sort((a, b) => a - b);
    expect(hours).toEqual([...Array(24).keys()]);

    qc.clear();
  });

  // -------------------------------------------------------------------------
  // AC-1: revenue is correctly bucketed by order's created_at hour
  // -------------------------------------------------------------------------

  it('AC-1: buckets revenue by order created_at hour — hour 8 gets $25, hour 20 gets $40', async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHourlyBreakdown(from, to), {
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
    const hour8 = rows.find(r => r.hour === 8);
    const hour20 = rows.find(r => r.hour === 20);

    expect(hour8?.revenue).toBe(25);
    expect(hour8?.orderCount).toBe(1);
    expect(hour20?.revenue).toBe(40);
    expect(hour20?.orderCount).toBe(1);

    qc.clear();
  });

  // -------------------------------------------------------------------------
  // AC-1: voided orders are excluded from hourly revenue
  // -------------------------------------------------------------------------

  it('AC-1: voided order items are excluded — hour 8 revenue is $25, not $1024', async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHourlyBreakdown(from, to), {
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

    const hour8 = result.current.data.data.find(r => r.hour === 8);
    // Voided item ($999) must be excluded; only the non-voided $25 item counts
    expect(hour8?.revenue).toBe(25);

    qc.clear();
  });

  // -------------------------------------------------------------------------
  // AC-1: date range filter excludes out-of-range tabs
  // -------------------------------------------------------------------------

  it('AC-1: date range filter excludes items from 2020 — total revenue is $65, not $565', async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHourlyBreakdown(from, to), {
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
    const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
    // $25 (hour 8) + $40 (hour 20) = $65; out-of-range $500 must be excluded
    expect(Math.round(totalRevenue * 100) / 100).toBe(65);

    qc.clear();
  });

  // -------------------------------------------------------------------------
  // AC-1: empty range returns 24 all-zero rows (not empty array)
  // -------------------------------------------------------------------------

  it('AC-1: returns 24 all-zero rows when date range has no orders', async () => {
    const from = new Date('2020-06-01T00:00:00.000Z');
    const to = new Date('2020-06-01T23:59:59.999Z');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHourlyBreakdown(from, to), {
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
    // fillMissingHours always produces 24 entries even with no data
    expect(rows).toHaveLength(24);
    expect(rows.every(r => r.revenue === 0)).toBe(true);

    qc.clear();
  });
});
