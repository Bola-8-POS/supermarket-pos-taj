// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { usePaymentMethodsReport } from './queries-reports';

// Jamie Chen (manager) — consistent with other integration tests in this suite
const STAFF_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e';

// Deterministic test IDs — prefix IT-PAYMETH to avoid FK collisions
const IT_SHIFT_ID = 'dd010000-dd01-4dd0-8dd0-dd0100000001';
const IT_CAJA_ID = 'dd020000-dd02-4dd0-8dd0-dd0200000002';
const IT_TAB_ID = 'dd030000-dd03-4dd0-8dd0-dd0300000003';
const IT_PAY_CASH = 'dd040000-dd04-4dd0-8dd0-dd0400000004';
const IT_PAY_CARD = 'dd050000-dd05-4dd0-8dd0-dd0500000005';
const IT_PAY_REOPENED_VOID = 'dd060000-dd06-4dd0-8dd0-dd0600000006';
const IT_PAY_REFUND = 'dd070000-dd07-4dd0-8dd0-dd0700000007';
const IT_PAY_OUT_OF_RANGE = 'dd080000-dd08-4dd0-8dd0-dd0800000008';

// Far-future date range so dev-environment data never contaminates these tests
// (same pattern as category-revenue-report.integration.test.ts).
const RANGE_FROM = new Date('2035-10-01T00:00:00.000Z');
const RANGE_TO = new Date('2035-10-31T23:59:59.000Z');
const IN_RANGE_PROCESSED_AT = '2035-10-15T12:00:00.000Z';
const OUT_OF_RANGE_PROCESSED_AT = '2036-01-01T00:00:00.000Z';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Integration: usePaymentMethodsReport — real Supabase
// Phase 24 Plan 06 Task 3 — SC-1, D-08, Assumption A3
// ---------------------------------------------------------------------------

describe('usePaymentMethodsReport — integration (real Supabase)', () => {
  beforeAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'jamie@barpos.dev', password: '567890' });
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
      status: 'paid',
      closed_at: IN_RANGE_PROCESSED_AT,
      customer_name: 'IT-paymeth-test',
      created_at: IN_RANGE_PROCESSED_AT,
    });
    if (tabR.error) throw new Error(`beforeEach tab: ${JSON.stringify(tabR.error)}`);

    // cash=100 + card=50 are the only legs that must count. reopened_void
    // (Phase 23 exclusion, A3) and is_refund=true rows must be excluded; an
    // out-of-range cash payment must also be excluded.
    const paymentsR = await testDb.from('payments').upsert([
      {
        id: IT_PAY_CASH,
        tab_id: IT_TAB_ID,
        method: 'cash',
        amount: 100,
        status: 'completed',
        is_refund: false,
        processed_by: STAFF_ID,
        processed_at: IN_RANGE_PROCESSED_AT,
        idempotency_key: 'it-paymeth-cash',
      },
      {
        id: IT_PAY_CARD,
        tab_id: IT_TAB_ID,
        method: 'card',
        amount: 50,
        status: 'completed',
        is_refund: false,
        processed_by: STAFF_ID,
        processed_at: IN_RANGE_PROCESSED_AT,
        idempotency_key: 'it-paymeth-card',
      },
      {
        id: IT_PAY_REOPENED_VOID,
        tab_id: IT_TAB_ID,
        method: 'cash',
        amount: 999,
        status: 'reopened_void',
        is_refund: false,
        processed_by: STAFF_ID,
        processed_at: IN_RANGE_PROCESSED_AT,
        idempotency_key: 'it-paymeth-reopened-void',
      },
      {
        id: IT_PAY_REFUND,
        tab_id: IT_TAB_ID,
        method: 'cash',
        amount: 888,
        status: 'completed',
        is_refund: true,
        processed_by: STAFF_ID,
        processed_at: IN_RANGE_PROCESSED_AT,
        idempotency_key: 'it-paymeth-refund',
      },
      {
        id: IT_PAY_OUT_OF_RANGE,
        tab_id: IT_TAB_ID,
        method: 'cash',
        amount: 777,
        status: 'completed',
        is_refund: false,
        processed_by: STAFF_ID,
        processed_at: OUT_OF_RANGE_PROCESSED_AT,
        idempotency_key: 'it-paymeth-out-of-range',
      },
    ]);
    if (paymentsR.error) throw new Error(`beforeEach payments: ${JSON.stringify(paymentsR.error)}`);
  });

  afterEach(async () => {
    await testDb
      .from('payments')
      .delete()
      .in('id', [
        IT_PAY_CASH,
        IT_PAY_CARD,
        IT_PAY_REOPENED_VOID,
        IT_PAY_REFUND,
        IT_PAY_OUT_OF_RANGE,
      ]);
    await testDb.from('tabs').delete().eq('id', IT_TAB_ID);
    await testDb.from('caja_sessions').delete().eq('id', IT_CAJA_ID);
    await testDb.from('shifts').delete().eq('id', IT_SHIFT_ID);
  });

  // ---------------------------------------------------------------------------
  // A3: reopened_void + refund rows excluded; D-08: rollup = sum of session rows
  // ---------------------------------------------------------------------------

  it('excludes reopened_void and refund rows, and the rollup row equals the sum of per-session rows', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePaymentMethodsReport(RANGE_FROM, RANGE_TO), {
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

    const sessionCash = rows.find(r => !r.isRollup && r.method === 'cash' && r.cajaSessionId === IT_CAJA_ID);
    const sessionCard = rows.find(r => !r.isRollup && r.method === 'card' && r.cajaSessionId === IT_CAJA_ID);
    const rollupCash = rows.find(r => r.isRollup && r.method === 'cash');
    const rollupCard = rows.find(r => r.isRollup && r.method === 'card');

    // Only the one non-refund, non-reopened_void, in-range cash leg counts.
    expect(sessionCash).toBeDefined();
    expect(sessionCash?.legCount).toBe(1);
    expect(sessionCash?.grossAmount).toBe(100);

    expect(sessionCard).toBeDefined();
    expect(sessionCard?.legCount).toBe(1);
    expect(sessionCard?.grossAmount).toBe(50);

    // D-08: the day-level rollup row (cajaSessionId=null) sums the per-session rows.
    expect(rollupCash).toBeDefined();
    expect(rollupCash?.cajaSessionId).toBeNull();
    expect(rollupCash?.legCount).toBe(sessionCash?.legCount);
    expect(rollupCash?.grossAmount).toBe(sessionCash?.grossAmount);

    expect(rollupCard).toBeDefined();
    expect(rollupCard?.cajaSessionId).toBeNull();
    expect(rollupCard?.grossAmount).toBe(sessionCard?.grossAmount);

    // A3: reopened_void ($999) and refund ($888) never surface as extra
    // gross amount on the cash row — if they leaked in, grossAmount would be
    // 100+999+888=1987 instead of 100.
    expect(sessionCash?.grossAmount).not.toBe(1987);

    qc.clear();
  });

  // ---------------------------------------------------------------------------
  // Date-range filter excludes out-of-range payments
  // ---------------------------------------------------------------------------

  it('excludes payments outside the queried date range', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePaymentMethodsReport(RANGE_FROM, RANGE_TO), {
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
    const sessionCash = rows.find(r => !r.isRollup && r.method === 'cash' && r.cajaSessionId === IT_CAJA_ID);
    // If the out-of-range $777 leaked in, grossAmount would be 877, not 100.
    expect(sessionCash?.grossAmount).toBe(100);

    qc.clear();
  });
});
