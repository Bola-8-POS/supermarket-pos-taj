// vi.unmock MUST be the very first statement — overrides the global Supabase mock in test-setup.ts
vi.unmock('@shared/lib/supabase');

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { testDb } from '@shared/lib/supabase-test-client';
import { useDeletionsPreReport } from './queries-reports';

// Jamie Chen (manager) — consistent with other integration tests in this suite
const STAFF_ID = 'cb969ea6-7443-4c03-ac99-bbe8aba0bb8e';

// Deterministic test IDs — prefix IT-DELPRE to avoid collisions with other tests.
// get_deletions_pre_report reads audit_logs directly (no join to a real orders
// row) so IT_ORDER_ID only needs to exist inside the `before` jsonb payload.
const IT_LOG_IN_RANGE = 'da010000-da01-4da0-8da0-da0100000001';
const IT_LOG_OUT_RANGE = 'da020000-da02-4da0-8da0-da0200000002';
const IT_ORDER_ID = 'da030000-da03-4da0-8da0-da0300000003';

// Far-future date range so dev-environment data never contaminates these tests
// (same pattern as category-revenue-report.integration.test.ts).
const RANGE_FROM = new Date('2035-07-01T00:00:00.000Z');
const RANGE_TO = new Date('2035-07-31T23:59:59.000Z');

let PRODUCT_ID: string;

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ---------------------------------------------------------------------------
// Integration: useDeletionsPreReport — real Supabase
// Phase 24 Plan 06 Task 2 — SC-1
// ---------------------------------------------------------------------------

describe('useDeletionsPreReport — integration (real Supabase)', () => {
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
    const logsR = await testDb.from('audit_logs').upsert([
      {
        id: IT_LOG_IN_RANGE,
        action: 'order_item.remove',
        entity_type: 'order_item',
        entity_id: IT_ORDER_ID,
        actor_id: STAFF_ID,
        before: { order_id: IT_ORDER_ID, product_id: PRODUCT_ID, quantity: 2 },
        after: { reason: 'Customer changed mind' },
        created_at: '2035-07-15T12:00:00.000Z',
      },
      {
        id: IT_LOG_OUT_RANGE,
        action: 'order_item.remove',
        entity_type: 'order_item',
        entity_id: IT_ORDER_ID,
        actor_id: STAFF_ID,
        before: { order_id: IT_ORDER_ID, product_id: PRODUCT_ID, quantity: 1 },
        after: { reason: 'Out of range removal' },
        created_at: '2036-01-01T00:00:00.000Z',
      },
    ]);
    if (logsR.error) throw new Error(`beforeEach audit_logs: ${JSON.stringify(logsR.error)}`);
  });

  afterEach(async () => {
    await testDb.from('audit_logs').delete().in('id', [IT_LOG_IN_RANGE, IT_LOG_OUT_RANGE]);
  });

  // ---------------------------------------------------------------------------
  // AC-1: rows contain all required fields
  // ---------------------------------------------------------------------------

  it('AC-1: in-range removal includes orderId, itemName, staffName, removedAt, and reason', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeletionsPreReport(RANGE_FROM, RANGE_TO), {
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
    const target = rows.find(r => r.orderId === IT_ORDER_ID && r.reason === 'Customer changed mind');

    expect(target).toBeDefined();
    expect(target?.itemName).toBe('Budweiser');
    expect(target?.staffName).toBe('Jamie Chen');
    expect(target?.removedAt).toBeInstanceOf(Date);
    expect(isNaN((target?.removedAt as Date).getTime())).toBe(false);

    qc.clear();
  });

  // ---------------------------------------------------------------------------
  // AC-2: date-range filter excludes out-of-range removals
  // ---------------------------------------------------------------------------

  it('AC-2: removal outside the queried range is excluded', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDeletionsPreReport(RANGE_FROM, RANGE_TO), {
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

    const outOfRange = result.current.data.data.find(r => r.reason === 'Out of range removal');
    expect(outOfRange).toBeUndefined();

    qc.clear();
  });
});
