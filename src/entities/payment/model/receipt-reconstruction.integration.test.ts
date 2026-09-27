// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { decomposeTax } from '../../../../supabase/functions/_shared/tax.ts';
import { useReceiptDataForPayment } from './queries';

// Manager Test — a seeded manager account present in this environment's local
// Supabase instance (jamie@barpos.dev, used by sibling report-integration
// tests in src/entities/tab/model/, is not seeded here — see setup-dev-users.ts,
// which syncs each profile's auth password to its `pin` column; deviation
// documented in 13-02-SUMMARY.md).
const STAFF_EMAIL = 'manager-test@test.local';
const STAFF_PASSWORD = '100002';

// Deterministic test IDs — unique prefix IT_RECEIPT to avoid collisions
const IT_SHIFT_ID = 'a1130000-a113-4a13-8a13-a11300000001';
const IT_CAJA_ID = 'b2230000-b223-4b23-8b23-b22300000002';
const IT_TAB_SINGLE = 'c3330000-c313-4c13-8c13-c31300000003';
const IT_TAB_SPLIT = 'd4430000-d413-4d13-8d13-d41300000004';
const IT_ORDER_SINGLE = 'e5530000-e513-4e13-8e13-e51300000005';
const IT_ORDER_VOIDED = 'f6630000-f613-4f13-8f13-f61300000006';
const IT_ORDER_SPLIT = '17730000-1713-4113-8113-171300000007';
const IT_ITEM_SINGLE = '28830000-2813-4213-8213-281300000008';
const IT_ITEM_VOIDED = '39930000-3913-4313-8313-391300000009';
const IT_ITEM_SPLIT = '4aa30000-4a13-4413-8413-4a130000000a';
const IT_UNKNOWN_TAB = '5bb30000-5b13-4513-8513-5b130000000b';

let STAFF_ID: string;
let PRODUCT_ID: string;

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Integration: fetchReceiptDataForPayment / useReceiptDataForPayment — real Supabase
// RCP-01 — see 13-02-PLAN.md Task 1
// ---------------------------------------------------------------------------

describe('useReceiptDataForPayment — integration (real Supabase)', () => {
  beforeAll(async () => {
    const { data: staffProfile } = await testDb
      .from('profiles')
      .select('id')
      .eq('email', STAFF_EMAIL)
      .maybeSingle();
    if (!staffProfile?.id)
      throw new Error(`No "${STAFF_EMAIL}" profile found — run npm run setup:dev`);
    STAFF_ID = staffProfile.id;

    const { data: product } = await testDb.from('products').select('id').limit(1).maybeSingle();
    if (!product?.id) throw new Error('No product found — run npm run setup:dev');
    PRODUCT_ID = product.id;

    await supabase.auth.signInWithPassword({ email: STAFF_EMAIL, password: STAFF_PASSWORD });
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

    const tabsR = await testDb.from('tabs').upsert([
      {
        id: IT_TAB_SINGLE,
        caja_session_id: IT_CAJA_ID,
        staff_id: STAFF_ID,
        shift_id: IT_SHIFT_ID,
        status: 'paid',
        customer_name: 'IT-receipt-single',
        closed_at: new Date().toISOString(),
      },
      {
        id: IT_TAB_SPLIT,
        caja_session_id: IT_CAJA_ID,
        staff_id: STAFF_ID,
        shift_id: IT_SHIFT_ID,
        status: 'paid',
        customer_name: 'IT-receipt-split',
        closed_at: new Date().toISOString(),
      },
    ]);
    if (tabsR.error) throw new Error(`beforeEach tabs: ${JSON.stringify(tabsR.error)}`);

    const ordersR = await testDb.from('orders').upsert([
      { id: IT_ORDER_SINGLE, tab_id: IT_TAB_SINGLE, staff_id: STAFF_ID, status: 'pending' },
      { id: IT_ORDER_VOIDED, tab_id: IT_TAB_SINGLE, staff_id: STAFF_ID, status: 'voided' },
      { id: IT_ORDER_SPLIT, tab_id: IT_TAB_SPLIT, staff_id: STAFF_ID, status: 'pending' },
    ]);
    if (ordersR.error) throw new Error(`beforeEach orders: ${JSON.stringify(ordersR.error)}`);

    // Top up inventory so the decrement trigger on order_items never drives
    // quantity_on_hand below zero (mirrors hourly-breakdown.integration.test.ts).
    const invR = await testDb
      .from('inventory')
      .upsert({ product_id: PRODUCT_ID, quantity_on_hand: 1000 }, { onConflict: 'product_id' });
    if (invR.error) throw new Error(`beforeEach inventory: ${JSON.stringify(invR.error)}`);

    const itemsR = await testDb.from('order_items').upsert([
      {
        id: IT_ITEM_SINGLE,
        order_id: IT_ORDER_SINGLE,
        product_id: PRODUCT_ID,
        quantity: 2,
        unit_price: 10,
        modifier_price_delta: 0,
        discount_rate: 10,
        discount_amount: 2,
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
        id: IT_ITEM_SPLIT,
        order_id: IT_ORDER_SPLIT,
        product_id: PRODUCT_ID,
        quantity: 1,
        unit_price: 50,
        modifier_price_delta: 0,
      },
    ]);
    if (itemsR.error) throw new Error(`beforeEach items: ${JSON.stringify(itemsR.error)}`);

    const paymentsR = await testDb.from('payments').upsert([
      {
        tab_id: IT_TAB_SINGLE,
        amount: 20,
        method: 'cash',
        tendered_amount: 20,
        processed_by: STAFF_ID,
        idempotency_key: `it-receipt-single-${IT_TAB_SINGLE}`,
        discount_scope: 'all',
        discount_type: 'fixed',
        discount_value: 1,
        discount_amount: 1,
      },
      {
        tab_id: IT_TAB_SPLIT,
        amount: 30,
        method: 'cash',
        tendered_amount: 30,
        processed_by: STAFF_ID,
        idempotency_key: `it-receipt-split-cash-${IT_TAB_SPLIT}`,
      },
      {
        tab_id: IT_TAB_SPLIT,
        amount: 20,
        method: 'card',
        tendered_amount: null,
        reference_number: 'TERM123',
        processed_by: STAFF_ID,
        idempotency_key: `it-receipt-split-card-${IT_TAB_SPLIT}`,
      },
    ]);
    if (paymentsR.error) throw new Error(`beforeEach payments: ${JSON.stringify(paymentsR.error)}`);
  });

  afterEach(async () => {
    // Delete in FK order: payments → order_items → orders → tabs → caja_sessions → shifts
    await testDb.from('payments').delete().in('tab_id', [IT_TAB_SINGLE, IT_TAB_SPLIT]);
    await testDb
      .from('order_items')
      .delete()
      .in('id', [IT_ITEM_SINGLE, IT_ITEM_VOIDED, IT_ITEM_SPLIT]);
    await testDb
      .from('orders')
      .delete()
      .in('id', [IT_ORDER_SINGLE, IT_ORDER_VOIDED, IT_ORDER_SPLIT]);
    await testDb.from('tabs').delete().in('id', [IT_TAB_SINGLE, IT_TAB_SPLIT]);
    await testDb.from('caja_sessions').delete().eq('id', IT_CAJA_ID);
    await testDb.from('shifts').delete().eq('id', IT_SHIFT_ID);
  });

  it('single-tender: reconstructs items, tenderedAmount/changeAmount from the sole leg, tenders.length === 1', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useReceiptDataForPayment(IT_TAB_SINGLE), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    const receipt = result.current.data!;
    expect(receipt.items).toHaveLength(1);
    expect(receipt.items[0]?.quantity).toBe(2);
    expect(receipt.items[0]?.unitPrice).toBe(10);
    expect(receipt.items[0]?.lineTotal).toBe(20);
    expect(receipt.items[0]?.discountRate).toBe(10);
    expect(receipt.items[0]?.discountAmount).toBe(2);
    expect(receipt.discountScope).toBe('all');
    expect(receipt.discountType).toBe('fixed');
    expect(receipt.discountValue).toBe(1);
    expect(receipt.discountAmount).toBe(1);
    expect(receipt.tenderedAmount).toBe(20);
    expect(receipt.changeAmount).toBe(0);
    expect(receipt.tenders).toHaveLength(1);
    // CR-01: reprint receipts must carry a real decomposed tax split, not
    // the pre-fix `subtotal === total` with no taxAmount at all.
    expect(receipt.taxAmount).toBeDefined();
    expect(receipt.subtotal + receipt.taxAmount!).toBeCloseTo(receipt.total, 2);

    qc.clear();
  });

  it('split-tender: groups both legs into ONE receipt — tenders.length === 2, subtotal/total sum both legs', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useReceiptDataForPayment(IT_TAB_SPLIT), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    const receipt = result.current.data!;
    expect(receipt.tenders).toHaveLength(2);
    const methods = new Set(receipt.tenders?.map(t => t.method));
    expect(methods).toEqual(new Set(['cash', 'card']));

    // Sum of BOTH legs (30 + 20), never a single leg's amount alone — total
    // is always the charged amount; subtotal is decomposed per the store's
    // live billing settings (CR-01), so derive the expectation the same way
    // fetchReceiptDataForPayment does rather than hardcoding a pre-tax-split
    // value.
    const { data: billingRow } = await testDb
      .from('settings')
      .select('value')
      .eq('key', 'billing')
      .maybeSingle();
    const billing = billingRow?.value as { taxRatePercent?: number; taxInclusive?: boolean } | null;
    const expected = decomposeTax(50, billing?.taxRatePercent ?? 16, billing?.taxInclusive ?? true);
    expect(receipt.total).toBe(50);
    expect(receipt.subtotal).toBe(expected.subtotal);
    expect(receipt.taxAmount).toBe(expected.taxAmount);

    qc.clear();
  });

  it('voided-order exclusion: a voided order and its item are not included in items', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useReceiptDataForPayment(IT_TAB_SINGLE), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 10_000 }
    );

    const receipt = result.current.data!;
    // Only the non-voided $20 item; the voided $999 item must be excluded.
    expect(receipt.items).toHaveLength(1);
    expect(receipt.items.some(i => i.lineTotal === 999)).toBe(false);

    qc.clear();
  });

  it('missing/unknown tab: rejects rather than resolving with a garbage/empty ReceiptData', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useReceiptDataForPayment(IT_UNKNOWN_TAB), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isError).toBe(true);
      },
      { timeout: 10_000 }
    );

    expect(result.current.data).toBeUndefined();

    qc.clear();
  });
});
