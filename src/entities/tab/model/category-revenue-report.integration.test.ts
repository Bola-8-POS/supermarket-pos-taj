// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { useCategoryRevenueReport } from './queries-reports';

// Jamie Chen (manager) — consistent with other integration tests in this suite
const STAFF_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e';

// Deterministic test IDs — prefix IT-CATREV to avoid FK collisions with other tests
const IT_SHIFT_ID = 'ca010000-ca01-4ca0-8ca0-ca0100000001';
const IT_CAJA_ID = 'cb020000-cb02-4cb0-8cb0-cb0200000002';
const IT_TAB_2035 = 'cc030000-cc03-4cc0-8cc0-cc0300000003';
const IT_TAB_2036 = 'cd040000-cd04-4cd0-8cd0-cd0400000004';
const IT_ORDER = 'ce050000-ce05-4ce0-8ce0-ce0500000005';
const IT_ITEM = 'cf060000-cf06-4cf0-8cf0-cf0600000006';

// Far-future date range so dev-environment data never contaminates these tests
const RANGE_2035_FROM = new Date('2035-06-01T00:00:00.000Z');
const RANGE_2035_TO = new Date('2035-06-30T23:59:59.000Z');

let PRODUCT_ID: string;
let BEER_CATEGORY_ID: string;

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Integration: useCategoryRevenueReport — real Supabase
// QA-written tests per AC-4 (POS-5): zero-revenue categories always appear
// ---------------------------------------------------------------------------

describe('useCategoryRevenueReport — integration (real Supabase)', () => {
  beforeAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'jamie@barpos.dev', password: '567890' });

    const { data: beer } = await testDb
      .from('products')
      .select('id, categories(id)')
      .eq('name', 'Budweiser')
      .maybeSingle();
    if (!beer?.id) throw new Error('Budweiser product missing — run npm run setup:dev');
    PRODUCT_ID = beer.id;

    BEER_CATEGORY_ID = (beer as any).categories?.id ?? '';
    if (!BEER_CATEGORY_ID) throw new Error('Budweiser has no category — check seed data');
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

    // Tab in 2035 — within RANGE_2035, used for in-range order seeding when needed
    const tab2035R = await testDb.from('tabs').upsert({
      id: IT_TAB_2035,
      caja_session_id: IT_CAJA_ID,
      staff_id: STAFF_ID,
      shift_id: IT_SHIFT_ID,
      status: 'closed',
      closed_at: '2035-06-15T12:00:00.000Z',
      customer_name: 'IT-catrev-2035',
      created_at: '2035-06-15T12:00:00.000Z',
    });
    if (tab2035R.error) throw new Error(`beforeEach tab-2035: ${JSON.stringify(tab2035R.error)}`);

    // Tab in 2036 — outside RANGE_2035, used for date-range-exclusion test
    const tab2036R = await testDb.from('tabs').upsert({
      id: IT_TAB_2036,
      caja_session_id: IT_CAJA_ID,
      staff_id: STAFF_ID,
      shift_id: IT_SHIFT_ID,
      status: 'closed',
      closed_at: '2036-01-01T00:00:00.000Z',
      customer_name: 'IT-catrev-2036',
      created_at: '2036-01-01T00:00:00.000Z',
    });
    if (tab2036R.error) throw new Error(`beforeEach tab-2036: ${JSON.stringify(tab2036R.error)}`);
  });

  afterEach(async () => {
    await testDb.from('order_items').delete().in('id', [IT_ITEM]);
    await testDb.from('orders').delete().in('id', [IT_ORDER]);
    await testDb.from('tabs').delete().in('id', [IT_TAB_2035, IT_TAB_2036]);
    await testDb.from('caja_sessions').delete().eq('id', IT_CAJA_ID);
    await testDb.from('shifts').delete().eq('id', IT_SHIFT_ID);
  });

  // ---------------------------------------------------------------------------
  // AC-4: zero-revenue categories always appear (the key fix from Attempt 2)
  // ---------------------------------------------------------------------------

  it('AC-4: all canonical categories appear with revenue=0 when no orders exist in the date range', async () => {
    // No orders seeded for RANGE_2035 — far-future range guarantees no dev-env contamination
    const { data: cats, error: catsErr } = await testDb.from('categories').select('id, name');
    expect(catsErr).toBeNull();
    const allCatIds = (cats ?? []).map((c: { id: string }) => c.id);
    expect(allCatIds.length).toBeGreaterThanOrEqual(1);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCategoryRevenueReport(RANGE_2035_FROM, RANGE_2035_TO), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 15_000 }
    );

    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;

    const rows = result.current.data.data;

    // Every canonical category must appear — even with no orders in the range
    for (const catId of allCatIds) {
      const row = rows.find(r => r.categoryId === catId);
      expect(row, `category ${catId} missing from zero-revenue result`).toBeDefined();
      expect(row?.revenue).toBe(0);
      expect(row?.unitsSold).toBe(0);
      expect(row?.orderCount).toBe(0);
      expect(row?.pctTotal).toBe(0);
    }
  });

  // ---------------------------------------------------------------------------
  // AC-2 + AC-4: date-range filter excludes out-of-range orders;
  // the affected category still appears with $0 revenue (not dropped from results)
  // ---------------------------------------------------------------------------

  it('AC-2 + AC-4: beer category shows $0.00 when its only order is outside the query range', async () => {
    // Seed beer order on IT_TAB_2036 (2036-01-01) — outside RANGE_2035
    const orderR = await testDb.from('orders').upsert({
      id: IT_ORDER,
      tab_id: IT_TAB_2036,
      staff_id: STAFF_ID,
      status: 'pending',
    });
    expect(orderR.error).toBeNull();

    const itemR = await testDb.from('order_items').upsert({
      id: IT_ITEM,
      order_id: IT_ORDER,
      product_id: PRODUCT_ID,
      quantity: 3,
      unit_price: 15,
      modifier_price_delta: 0,
    });
    expect(itemR.error).toBeNull();

    // Query RANGE_2035 — the 2036 beer order must not contribute revenue
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCategoryRevenueReport(RANGE_2035_FROM, RANGE_2035_TO), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(
      () => {
        expect(result.current.isSuccess).toBe(true);
      },
      { timeout: 15_000 }
    );
    expect(result.current.data?.ok).toBe(true);
    if (!result.current.data?.ok) return;

    const rows = result.current.data.data;
    const beerRow = rows.find(r => r.categoryId === BEER_CATEGORY_ID);

    // AC-4: beer category must still appear in the result (not absent despite $0 revenue)
    expect(beerRow, 'beer category missing — zero-revenue fill broken').toBeDefined();
    // AC-2: revenue for beer must be 0 (out-of-range order excluded)
    expect(beerRow?.revenue).toBe(0);
    expect(beerRow?.pctTotal).toBe(0);
  });
});
