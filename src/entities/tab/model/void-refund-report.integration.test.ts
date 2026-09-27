// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { useVoidRefundReport } from './queries-reports';

// Jamie Chen (manager) — consistent with other integration tests in this suite
const STAFF_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e';

// Deterministic test IDs — prefix IT-VRVOID to avoid FK collisions with other tests
const IT_SHIFT_ID = 'aa010000-aa01-4aa0-8aa0-aa0100000001';
const IT_CAJA_ID = 'bb020000-bb02-4bb0-8bb0-bb0200000002';
const IT_TAB_ID = 'cc030000-cc03-4cc0-8cc0-cc0300000003';
const IT_ORDER_VOIDED_IN_RANGE = 'dd040000-dd04-4dd0-8dd0-dd0400000004';
const IT_ORDER_VOIDED_OUT_RANGE = 'ee050000-ee05-4ee0-8ee0-ee0500000005';
const IT_ITEM_BEER_IN = 'ff060000-ff06-4ff0-8ff0-ff0600000006';
const IT_ITEM_BEER_OUT = '11070000-1107-4110-8110-110700000007';

let PRODUCT_ID: string;

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Integration: useVoidRefundReport — real Supabase
// QA-written tests per AC-1, AC-2 of POS-4
// ---------------------------------------------------------------------------

describe('useVoidRefundReport — integration (real Supabase)', () => {
  beforeAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'jamie@barpos.dev', password: '567890' });

    const { data: prod } = await testDb
      .from('products')
      .select('id')
      .eq('name', 'Budweiser')
      .maybeSingle();
    if (!prod?.id) throw new Error('Budweiser product missing — run npm run setup:dev');
    PRODUCT_ID = prod.id;
  });

  afterAll(async () => {
    await supabase.auth.signOut();
  });

  beforeEach(async () => {
    const shiftR = await testDb.from('shifts').upsert({
      id: IT_SHIFT_ID,
      staff_id: STAFF_ID,
      opening_cash: 0,
      clock_in: new Date().toISOString(),
    });
    if (shiftR.error) throw new Error(`beforeEach shift: ${JSON.stringify(shiftR.error)}`);

    const cajaR = await testDb.from('caja_sessions').upsert({
      id: IT_CAJA_ID,
      opened_by: STAFF_ID,
      opening_cash: 0,
      closing_cash: 0,
      status: 'closed',
      closed_at: new Date().toISOString(),
    });
    if (cajaR.error) throw new Error(`beforeEach caja: ${JSON.stringify(cajaR.error)}`);

    const tabR = await testDb.from('tabs').upsert({
      id: IT_TAB_ID,
      caja_session_id: IT_CAJA_ID,
      staff_id: STAFF_ID,
      shift_id: IT_SHIFT_ID,
      status: 'closed',
      closed_at: new Date().toISOString(),
      customer_name: 'IT-vrvoid-test',
      created_at: new Date().toISOString(),
    });
    if (tabR.error) throw new Error(`beforeEach tab: ${JSON.stringify(tabR.error)}`);

    // Two voided orders: one updated_at today (in range), one from 2020 (out of range)
    const today = new Date().toISOString();
    const ordersR = await testDb.from('orders').upsert([
      {
        id: IT_ORDER_VOIDED_IN_RANGE,
        tab_id: IT_TAB_ID,
        staff_id: STAFF_ID,
        status: 'voided',
        void_reason: 'Customer walked out',
        updated_at: today,
      },
      {
        id: IT_ORDER_VOIDED_OUT_RANGE,
        tab_id: IT_TAB_ID,
        staff_id: STAFF_ID,
        status: 'voided',
        void_reason: 'Old voided order',
        updated_at: '2020-06-15T10:00:00.000Z',
      },
    ]);
    if (ordersR.error) throw new Error(`beforeEach orders: ${JSON.stringify(ordersR.error)}`);

    // One order_item per voided order — used for amount aggregation
    const itemsR = await testDb.from('order_items').upsert([
      {
        id: IT_ITEM_BEER_IN,
        order_id: IT_ORDER_VOIDED_IN_RANGE,
        product_id: PRODUCT_ID,
        quantity: 3,
        unit_price: 10,
        modifier_price_delta: 0,
      },
      {
        id: IT_ITEM_BEER_OUT,
        order_id: IT_ORDER_VOIDED_OUT_RANGE,
        product_id: PRODUCT_ID,
        quantity: 1,
        unit_price: 999,
        modifier_price_delta: 0,
      },
    ]);
    if (itemsR.error) throw new Error(`beforeEach items: ${JSON.stringify(itemsR.error)}`);
  });

  afterEach(async () => {
    await testDb.from('order_items').delete().in('id', [IT_ITEM_BEER_IN, IT_ITEM_BEER_OUT]);
    await testDb
      .from('orders')
      .delete()
      .in('id', [IT_ORDER_VOIDED_IN_RANGE, IT_ORDER_VOIDED_OUT_RANGE]);
    await testDb.from('tabs').delete().eq('id', IT_TAB_ID);
    await testDb.from('caja_sessions').delete().eq('id', IT_CAJA_ID);
    await testDb.from('shifts').delete().eq('id', IT_SHIFT_ID);
  });

  // ---------------------------------------------------------------------------
  // AC-1: rows contain all four required fields
  // ---------------------------------------------------------------------------

  it('AC-1: in-range voided order includes orderId, staffName, amount, and reason', async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useVoidRefundReport(from, to), {
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
    const target = rows.find(r => r.orderId === IT_ORDER_VOIDED_IN_RANGE);

    // AC-1: all four columns present
    expect(target).toBeDefined();
    expect(target?.staffName).toBe('Jamie Chen');
    // 3 × $10 = $30
    expect(target?.amount).toBe(30);
    expect(target?.reason).toBe('Customer walked out');
    // voidedAt is a Date — must be a valid Date object
    expect(target?.voidedAt).toBeInstanceOf(Date);
    expect(isNaN((target?.voidedAt as Date).getTime())).toBe(false);

    qc.clear();
  });

  // ---------------------------------------------------------------------------
  // AC-2: date-range filter — out-of-range order is excluded by the query
  // ---------------------------------------------------------------------------

  it('AC-2: order with updated_at in 2020 is excluded when querying today', async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useVoidRefundReport(from, to), {
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
    const outOfRange = rows.find(r => r.orderId === IT_ORDER_VOIDED_OUT_RANGE);

    // The 2020 order must NOT appear in today's report
    expect(outOfRange).toBeUndefined();

    qc.clear();
  });

  // ---------------------------------------------------------------------------
  // AC-1+2: error is null on success — never ignore the Supabase error field
  // ---------------------------------------------------------------------------

  it('query returns ok:true and error is not present on successful fetch', async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useVoidRefundReport(from, to), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    // Result must be ok — if error was propagated, this would fail
    expect(result.current.data?.ok).toBe(true);

    qc.clear();
  });
});
