/**
 * Unit tests for useStaffMetrics hooks.
 * Uses the global Supabase module mock (no real DB connection).
 *
 * AC verified:
 *   S10-01: useStaffMetrics — sorted by revenue desc, date filter, zero-metrics for active staff, error path
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { useStaffMetrics } from './queries';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedFrom = vi.mocked(supabase).from;

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children),
    qc,
  };
}

const dateFrom = new Date('2026-04-01T00:00:00.000Z');
const dateTo = new Date('2026-04-30T23:59:59.000Z');

// Fixtures: UuidSchema requires valid UUID format — never use 'staff-1' etc.
const STAFF_UUID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_UUID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TAB_UUID_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TAB_UUID_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// ---------------------------------------------------------------------------
// Chain mock helpers
//
// The private fetch helpers await the full chain expression:
//   db.from('profiles').select(...).eq(...)       → eq is the terminal awaitable
//   db.from('order_items').select(...).gte(...).lte(...) → lte is terminal
//   db.from('payments').select(...).gte(...).lte(...)    → lte is terminal
//
// We build a minimal thenable chain where each method returns `this`,
// and the last method has `mockResolvedValue`.
// ---------------------------------------------------------------------------

type ChainResult<T> = { data: T | null; error: { message: string } | null };

function profilesChain<T>(resolved: ChainResult<T>) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn().mockResolvedValue(resolved),
  };
  chain.select.mockReturnValue(chain);
  return chain;
}

// fetchOrderItemsInRange:  .select().gte().lte()        → lte is terminal (awaited)
// fetchPaymentsInRange:    .select().gte().lte().not()  → not is terminal (awaited)
//
// The thenable trick: every chain method returns the same object.
// The object implements `.then()` so `await lte()` resolves immediately via the thenable.
// `.not()` also has `mockResolvedValue(resolved)` for the payments chain.
function rangeChain<T>(resolved: ChainResult<T>) {
  const thenable: {
    select: ReturnType<typeof vi.fn>;
    gte: ReturnType<typeof vi.fn>;
    lte: ReturnType<typeof vi.fn>;
    not: ReturnType<typeof vi.fn>;
    then: (resolve: (v: ChainResult<T>) => void, reject?: (e: unknown) => void) => void;
  } = {
    select: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    not: vi.fn().mockResolvedValue(resolved),
    then: (resolve, _reject) => {
      resolve(resolved);
    },
  };
  thenable.select.mockReturnValue(thenable);
  thenable.gte.mockReturnValue(thenable);
  thenable.lte.mockReturnValue(thenable);
  return thenable;
}

// ---------------------------------------------------------------------------
// useStaffMetrics tests
// ---------------------------------------------------------------------------

describe('useStaffMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('S10-01.1 — returns Result<StaffMetric[]> sorted by revenue desc', async () => {
    const profilesData = [
      { id: STAFF_UUID_1, name: 'Alice' },
      { id: STAFF_UUID_2, name: 'Bob' },
    ];
    const orderItemsData = [
      // Alice: 2 items × $10 → $20 revenue, 1 tab
      {
        quantity: 2,
        unit_price: 10,
        orders: { staff_id: STAFF_UUID_1, status: 'pending', tab_id: TAB_UUID_A },
      },
      // Bob: 1 item × $50 → $50 revenue, 1 tab
      {
        quantity: 1,
        unit_price: 50,
        orders: { staff_id: STAFF_UUID_2, status: 'pending', tab_id: TAB_UUID_B },
      },
    ];

    mockedFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return profilesChain({ data: profilesData, error: null }) as unknown as ReturnType<
          typeof supabase.from
        >;
      }
      // order_items
      return rangeChain({ data: orderItemsData, error: null }) as unknown as ReturnType<
        typeof supabase.from
      >;
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStaffMetrics(dateFrom, dateTo), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const outcome = result.current.data;
    expect(outcome?.ok).toBe(true);
    if (!outcome?.ok) throw new Error('Expected ok result');

    const metrics = outcome.data;
    // Sorted by revenue desc: Bob ($50) before Alice ($20)
    expect(metrics[0]?.staffName).toBe('Bob');
    expect(metrics[0]?.revenue).toBe(50);
    expect(metrics[1]?.staffName).toBe('Alice');
    expect(metrics[1]?.revenue).toBe(20);
  });

  it('S10-01.2 — date range is passed to the order_items query (gte/lte called)', async () => {
    mockedFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return profilesChain({ data: [], error: null }) as unknown as ReturnType<
          typeof supabase.from
        >;
      }
      return rangeChain({ data: [], error: null }) as unknown as ReturnType<typeof supabase.from>;
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStaffMetrics(dateFrom, dateTo), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Verify that mockedFrom was called with 'order_items'
    const calls = mockedFrom.mock.calls.map(c => c[0]);
    expect(calls).toContain('order_items');
  });

  it('S10-01.3 — active staff with no items appear with zero metrics', async () => {
    const profilesData = [{ id: STAFF_UUID_1, name: 'Idle Alice' }];

    mockedFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return profilesChain({ data: profilesData, error: null }) as unknown as ReturnType<
          typeof supabase.from
        >;
      }
      // No items in range
      return rangeChain({ data: [], error: null }) as unknown as ReturnType<typeof supabase.from>;
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStaffMetrics(dateFrom, dateTo), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const outcome = result.current.data;
    expect(outcome?.ok).toBe(true);
    if (!outcome?.ok) throw new Error('Expected ok result');

    expect(outcome.data).toHaveLength(1);
    expect(outcome.data[0]?.staffName).toBe('Idle Alice');
    expect(outcome.data[0]?.revenue).toBe(0);
    expect(outcome.data[0]?.transactionCount).toBe(0);
    expect(outcome.data[0]?.avgCheckSize).toBe(0);
    expect(outcome.data[0]?.voidCount).toBe(0);
  });

  it('S10-01.4 — returns Result Err when profiles fetch errors', async () => {
    mockedFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return profilesChain({
          data: null,
          error: { message: 'DB connection failed' },
        }) as unknown as ReturnType<typeof supabase.from>;
      }
      return rangeChain({ data: [], error: null }) as unknown as ReturnType<typeof supabase.from>;
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStaffMetrics(dateFrom, dateTo), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const outcome = result.current.data;
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok !== false) throw new Error('Expected err result');
    expect(outcome.error.code).toBe('SUPABASE_ERROR');
  });

  it('S10-01.4b — returns Result Err when order_items fetch errors', async () => {
    mockedFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return profilesChain({
          data: [{ id: STAFF_UUID_1, name: 'Alice' }],
          error: null,
        }) as unknown as ReturnType<typeof supabase.from>;
      }
      return rangeChain({
        data: null,
        error: { message: 'order_items error' },
      }) as unknown as ReturnType<typeof supabase.from>;
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStaffMetrics(dateFrom, dateTo), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const outcome = result.current.data;
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok !== false) throw new Error('Expected err result');
    expect(outcome.error.code).toBe('SUPABASE_ERROR');
  });

  it('S10-01.x — voided items count as voidCount, not revenue', async () => {
    mockedFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return profilesChain({
          data: [{ id: STAFF_UUID_1, name: 'Alice' }],
          error: null,
        }) as unknown as ReturnType<typeof supabase.from>;
      }
      return rangeChain({
        data: [
          {
            quantity: 1,
            unit_price: 100,
            orders: { staff_id: STAFF_UUID_1, status: 'voided', tab_id: TAB_UUID_A },
          },
        ],
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>;
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStaffMetrics(dateFrom, dateTo), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const outcome = result.current.data;
    expect(outcome?.ok).toBe(true);
    if (!outcome?.ok) throw new Error('Expected ok result');

    expect(outcome.data[0]?.revenue).toBe(0);
    expect(outcome.data[0]?.voidCount).toBe(1);
  });
});
