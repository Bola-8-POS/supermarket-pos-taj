// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { useOpenTabsPendingTotal } from './queries';

// Use Jamie (manager) as owner of all seeded rows.
// Alex's ID is used in queries.clock.test.ts with a broad open-shift delete that would
// race-delete our shift; Jamie's shifts are not targeted by that cleanup.
const STAFF_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e'; // Jamie Chen (jamie@barpos.dev)

// Deterministic test IDs — unique prefix IT-PEND to avoid collisions with other integration tests
const IT_SHIFT_ID = 'e1e10000-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const IT_CAJA_ID = 'f2f20000-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
const IT_TAB_1 = 'a3a30000-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
const IT_TAB_2 = 'b4b40000-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
const IT_TAB_CLOSED = 'c5c50000-c5c5-4c5c-8c5c-c5c5c5c5c5c5';
const IT_ORDER_1 = 'd6d60000-d6d6-4d6d-8d6d-d6d6d6d6d6d6';
const IT_ORDER_2 = 'e7e70000-e7e7-4e7e-8e7e-e7e7e7e7e7e7';
const IT_ORDER_CLOSED = 'f8f80000-f8f8-4f8f-8f8f-f8f8f8f8f8f8';
const IT_ITEM_1A = '11110000-1111-4111-8111-111111111111';
const IT_ITEM_1B = '22220000-2222-4222-8222-222222222222';
const IT_ITEM_2A = '33330000-3333-4333-8333-333333333333';
const IT_ITEM_CLOSED = '44440000-4444-4444-8444-444444444444';

let PRODUCT_ID: string;

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Integration: useOpenTabsPendingTotal — real Supabase
// ---------------------------------------------------------------------------

describe('useOpenTabsPendingTotal — integration (real Supabase)', () => {
  beforeAll(async () => {
    // Managers can read tabs from any session — required for the hook to succeed over RLS
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
    // Seed shift (needed as FK for tabs)
    const shiftR = await testDb.from('shifts').upsert({
      id: IT_SHIFT_ID,
      staff_id: STAFF_ID,
      opening_cash: 0,
      clock_in: new Date().toISOString(),
    });
    if (shiftR.error) throw new Error(`beforeEach shift: ${JSON.stringify(shiftR.error)}`);

    // Close any existing open caja sessions — the DB enforces only ONE open session at a time
    const closeR = await testDb
      .from('caja_sessions')
      .update({ status: 'closed', closed_at: new Date().toISOString(), closing_cash: 0 })
      .eq('status', 'open')
      .neq('id', IT_CAJA_ID);
    if (closeR.error) throw new Error(`beforeEach close-others: ${JSON.stringify(closeR.error)}`);

    // Seed caja session with known ID
    const cajaR = await testDb.from('caja_sessions').upsert({
      id: IT_CAJA_ID,
      opened_by: STAFF_ID,
      opening_cash: 0,
      status: 'open',
    });
    if (cajaR.error) throw new Error(`beforeEach caja: ${JSON.stringify(cajaR.error)}`);

    // Seed tabs: two open + one closed, all linked to the same caja session
    const tabsR = await testDb.from('tabs').upsert([
      {
        id: IT_TAB_1,
        caja_session_id: IT_CAJA_ID,
        staff_id: STAFF_ID,
        shift_id: IT_SHIFT_ID,
        status: 'open',
        customer_name: 'IT-pending-tab-1',
      },
      {
        id: IT_TAB_2,
        caja_session_id: IT_CAJA_ID,
        staff_id: STAFF_ID,
        shift_id: IT_SHIFT_ID,
        status: 'open',
        customer_name: 'IT-pending-tab-2',
      },
      {
        id: IT_TAB_CLOSED,
        caja_session_id: IT_CAJA_ID,
        staff_id: STAFF_ID,
        shift_id: IT_SHIFT_ID,
        status: 'closed',
        closed_at: new Date().toISOString(),
        customer_name: 'IT-pending-tab-closed',
      },
    ]);
    if (tabsR.error) throw new Error(`beforeEach tabs: ${JSON.stringify(tabsR.error)}`);

    // Seed orders
    const ordersR = await testDb.from('orders').upsert([
      { id: IT_ORDER_1, tab_id: IT_TAB_1, staff_id: STAFF_ID },
      { id: IT_ORDER_2, tab_id: IT_TAB_2, staff_id: STAFF_ID },
      { id: IT_ORDER_CLOSED, tab_id: IT_TAB_CLOSED, staff_id: STAFF_ID },
    ]);
    if (ordersR.error) throw new Error(`beforeEach orders: ${JSON.stringify(ordersR.error)}`);

    // Seed order_items:
    //   tab-1 order: 2×$10 + 1×($15+$2 modifier) = $20 + $17 = $37
    //   tab-2 order: 3×($5+$1 modifier)            = $18
    //   closed-tab:  1×$100                         = $100 (MUST NOT appear in pending total)
    const itemsR = await testDb.from('order_items').upsert([
      {
        id: IT_ITEM_1A,
        order_id: IT_ORDER_1,
        product_id: PRODUCT_ID,
        quantity: 2,
        unit_price: 10,
        modifier_price_delta: 0,
      },
      {
        id: IT_ITEM_1B,
        order_id: IT_ORDER_1,
        product_id: PRODUCT_ID,
        quantity: 1,
        unit_price: 15,
        modifier_price_delta: 2,
      },
      {
        id: IT_ITEM_2A,
        order_id: IT_ORDER_2,
        product_id: PRODUCT_ID,
        quantity: 3,
        unit_price: 5,
        modifier_price_delta: 1,
      },
      {
        id: IT_ITEM_CLOSED,
        order_id: IT_ORDER_CLOSED,
        product_id: PRODUCT_ID,
        quantity: 1,
        unit_price: 100,
        modifier_price_delta: 0,
      },
    ]);
    if (itemsR.error) throw new Error(`beforeEach order_items: ${JSON.stringify(itemsR.error)}`);
  });

  afterEach(async () => {
    // Delete in FK order: order_items → orders → tabs → caja_sessions → shifts
    await testDb
      .from('order_items')
      .delete()
      .in('id', [IT_ITEM_1A, IT_ITEM_1B, IT_ITEM_2A, IT_ITEM_CLOSED]);
    await testDb.from('orders').delete().in('id', [IT_ORDER_1, IT_ORDER_2, IT_ORDER_CLOSED]);
    await testDb.from('tabs').delete().in('id', [IT_TAB_1, IT_TAB_2, IT_TAB_CLOSED]);
    await testDb.from('caja_sessions').delete().eq('id', IT_CAJA_ID);
    await testDb.from('shifts').delete().eq('id', IT_SHIFT_ID);
  });

  it('returns sum of open tabs only — closed tab revenue is excluded', async () => {
    // tab-1 = $37, tab-2 = $18 → expected $55. Closed tab ($100) must not appear.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOpenTabsPendingTotal(IT_CAJA_ID), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (result.current.data?.ok) {
      expect(result.current.data.data).toBe(55);
    }
    qc.clear();
  });

  it('returns $0 when all tabs in the session are closed', async () => {
    await testDb
      .from('tabs')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .in('id', [IT_TAB_1, IT_TAB_2]);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOpenTabsPendingTotal(IT_CAJA_ID), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (result.current.data?.ok) {
      expect(result.current.data.data).toBe(0);
    }
    qc.clear();
  });

  it('returns $0 when queried with a cajaId that has no tabs', async () => {
    // Use a valid-format UUID that has no associated tabs
    const EMPTY_CAJA_ID = 'deadbeef-dead-4ead-8ead-deadbeefdead';
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOpenTabsPendingTotal(EMPTY_CAJA_ID), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (result.current.data?.ok) {
      expect(result.current.data.data).toBe(0);
    }
    qc.clear();
  });

  it('is disabled (no fetch) when cajaId is null — AC: "$0.00 without layout shift"', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useOpenTabsPendingTotal(null), {
      wrapper: makeWrapper(qc),
    });

    // Query must not run at all — data must be undefined and fetching must be false
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(false);
    qc.clear();
  });
});
