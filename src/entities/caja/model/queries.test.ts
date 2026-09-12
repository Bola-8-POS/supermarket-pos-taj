/**
 * Unit tests for caja + tab query hooks:
 *   - useCajaPaymentSummary (grouping by payment method)
 *   - useOpenTabsPendingTotal (summing open-tab revenue)
 *
 * Property-based coverage via fast-check for net_collected invariant.
 */

import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as fc from 'fast-check';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useOpenTabsPendingTotal } from '@entities/tab/model/queries';
import i18n from '@shared/lib/i18n';
import { supabase } from '@shared/lib/supabase';
import { createTestQueryClient } from '@shared/lib/test-utils';
import { useCajaPaymentSummary, useMutationCreateCajaEntry } from './queries';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// ---------------------------------------------------------------------------
// Supabase mock handle
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedFrom = vi.mocked(supabase).from;

// ---------------------------------------------------------------------------
// useCajaPaymentSummary
// ---------------------------------------------------------------------------

describe('useCajaPaymentSummary', () => {
  const testSession = {
    id: 'caja-abc',
    openedAt: new Date('2026-04-20T08:00:00.000Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all zeros when there are no payments for the session', async () => {
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockResolvedValue({ data: [], error: null }),
        }) as unknown as ReturnType<typeof supabase.from>
    );

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useCajaPaymentSummary(testSession), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    const summary = result.current.data?.ok ? result.current.data.data : null;
    expect(summary).toEqual({
      cash: 0,
      card: 0,
      bank_transfer: 0,
      rappi: 0,
      uber_eats: 0,
    });
  });

  it('correctly sums payments grouped by method', async () => {
    const payments = [
      { amount: 100, method: 'cash' },
      { amount: 50, method: 'cash' },
      { amount: 200, method: 'card' },
      { amount: 75, method: 'rappi' },
      { amount: 30, method: 'uber_eats' },
      { amount: 20, method: 'bank_transfer' },
    ];

    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockResolvedValue({ data: payments, error: null }),
        }) as unknown as ReturnType<typeof supabase.from>
    );

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useCajaPaymentSummary(testSession), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    const summary = result.current.data?.ok ? result.current.data.data : null;
    expect(summary).toEqual({
      cash: 150,
      card: 200,
      bank_transfer: 20,
      rappi: 75,
      uber_eats: 30,
    });
  });

  it('returns error Result when Supabase returns an error', async () => {
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi
            .fn()
            .mockResolvedValue({ data: null, error: { message: 'DB error', code: '500' } }),
        }) as unknown as ReturnType<typeof supabase.from>
    );

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useCajaPaymentSummary(testSession), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.data?.ok).toBe(false);
  });

  it('returns undefined data and is disabled when cajaSession is null', () => {
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useCajaPaymentSummary(null), {
      wrapper: makeWrapper(qc),
    });

    // Query is disabled — data is undefined, not loading
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(false);
  });

  it('is configured with refetchInterval of 30000ms', () => {
    // The hook sets refetchInterval: 30_000. We verify via the QueryCache observer.
    const qc = createTestQueryClient();
    renderHook(() => useCajaPaymentSummary(testSession), { wrapper: makeWrapper(qc) });

    const cache = qc.getQueryCache().findAll({
      queryKey: ['caja', 'payment-summary', testSession.id],
    });
    expect(cache.length).toBeGreaterThan(0);
    expect(cache[0]?.observers[0]?.options.refetchInterval).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// useOpenTabsPendingTotal
// ---------------------------------------------------------------------------

describe('useOpenTabsPendingTotal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The hook calls .from().select().eq().eq() — two chained eq calls, then
   * awaits the whole chain. We build a thenable where every method returns
   * itself so the final `await` resolves correctly.
   */
  function mockTabsChain(resolvedValue: { data: unknown; error: unknown }) {
    const thenable = {
      select: vi.fn(),
      eq: vi.fn(),
      then: (
        resolve: (v: { data: unknown; error: unknown }) => void,
        _reject?: (e: unknown) => void
      ) => {
        resolve(resolvedValue);
      },
    };
    thenable.select.mockReturnValue(thenable);
    thenable.eq.mockReturnValue(thenable);
    mockedFrom.mockReturnValue(thenable as unknown as ReturnType<typeof supabase.from>);
  }

  it('returns 0 when no open tabs exist for the session', async () => {
    mockTabsChain({ data: [], error: null });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useOpenTabsPendingTotal('caja-123'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    const total = result.current.data?.ok ? result.current.data.data : -1;
    expect(total).toBe(0);
  });

  it('sums revenue from open tabs correctly', async () => {
    // tab-1: (2*10) + (1*(15+2)) = 20 + 17 = 37
    // tab-2: (3*(5+1)) + (1*20)  = 18 + 20 = 38
    // total: 75
    const tabRows = [
      {
        id: 'tab-1',
        orders: [
          {
            order_items: [
              { quantity: 2, unit_price: 10, modifier_price_delta: 0 },
              { quantity: 1, unit_price: 15, modifier_price_delta: 2 },
            ],
          },
        ],
      },
      {
        id: 'tab-2',
        orders: [
          { order_items: [{ quantity: 3, unit_price: 5, modifier_price_delta: 1 }] },
          { order_items: [{ quantity: 1, unit_price: 20, modifier_price_delta: 0 }] },
        ],
      },
    ];

    mockTabsChain({ data: tabRows, error: null });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useOpenTabsPendingTotal('caja-123'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    const total = result.current.data?.ok ? result.current.data.data : -1;
    expect(total).toBe(75);
  });

  it('does not include tabs with null orders (treats them as $0)', async () => {
    const tabRows = [
      { id: 'tab-null-orders', orders: null },
      {
        id: 'tab-with-data',
        orders: [{ order_items: [{ quantity: 1, unit_price: 50, modifier_price_delta: 0 }] }],
      },
    ];

    mockTabsChain({ data: tabRows, error: null });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useOpenTabsPendingTotal('caja-123'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    const total = result.current.data?.ok ? result.current.data.data : -1;
    expect(total).toBe(50);
  });

  it('returns error Result when Supabase returns an error', async () => {
    mockTabsChain({ data: null, error: { message: 'DB error' } });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useOpenTabsPendingTotal('caja-123'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.data?.ok).toBe(false);
  });

  it('is disabled and returns no data when cajaId is null', () => {
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useOpenTabsPendingTotal(null), {
      wrapper: makeWrapper(qc),
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(false);
  });

  it('is configured with refetchInterval of 30000ms', () => {
    const qc = createTestQueryClient();
    renderHook(() => useOpenTabsPendingTotal('caja-xyz'), { wrapper: makeWrapper(qc) });

    const cache = qc.getQueryCache().findAll({
      queryKey: ['tabs', 'pending-total', 'caja-xyz'],
    });
    expect(cache.length).toBeGreaterThan(0);
    expect(cache[0]?.observers[0]?.options.refetchInterval).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Property-based: net_collected = sum of all payment amounts regardless of method
// ---------------------------------------------------------------------------

describe('useCajaPaymentSummary – property-based', () => {
  const testSession = {
    id: 'caja-prop',
    openedAt: new Date('2026-04-20T08:00:00.000Z'),
  };

  it('net_collected always equals sum(all amounts) regardless of method breakdown', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            method: fc.constantFrom('cash', 'card', 'bank_transfer', 'rappi', 'uber_eats'),
            amount: fc.float({ min: 0, max: 9999, noNaN: true }),
          }),
          { minLength: 0, maxLength: 20 }
        ),
        async payments => {
          vi.clearAllMocks();

          mockedFrom.mockImplementation(
            () =>
              ({
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                is: vi.fn().mockResolvedValue({ data: payments, error: null }),
              }) as unknown as ReturnType<typeof supabase.from>
          );

          const qc = createTestQueryClient();
          const { result } = renderHook(() => useCajaPaymentSummary(testSession), {
            wrapper: makeWrapper(qc),
          });

          await waitFor(() => {
            expect(result.current.data).toBeDefined();
          });

          const r = result.current.data;
          expect(r?.ok).toBe(true);
          if (!r?.ok) return;

          const { cash, card, bank_transfer, rappi, uber_eats } = r.data;
          const netCollected = cash + card + bank_transfer + rappi + uber_eats;

          const expectedTotal = payments.reduce(
            (acc, p) => acc + (typeof p.amount === 'number' ? p.amount : 0),
            0
          );

          expect(netCollected).toBeCloseTo(expectedTotal, 3);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// useMutationCreateCajaEntry
// ---------------------------------------------------------------------------

describe('useMutationCreateCajaEntry', () => {
  const baseInput = {
    cajaSessionId: 'caja-abc',
    type: 'expense' as const,
    amount: 50,
    concept: 'Ice delivery',
    staffId: 'staff-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a translated generic message when the insert fails with an unmapped Postgres error', async () => {
    mockedFrom.mockImplementation(
      () =>
        ({
          insert: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'db exploded', code: '55555', details: '', hint: '' },
          }),
        }) as unknown as ReturnType<typeof supabase.from>
    );

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationCreateCajaEntry(), {
      wrapper: makeWrapper(qc),
    });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('SUPABASE_ERROR');
      expect(res.error.message).not.toBe('db exploded');
      expect(res.error.message).toBe(i18n.t('featOrders:registerCajaEntry.genericError'));
    }
  });

  it('leaves an already-mapped duplicate-entry error unchanged', async () => {
    mockedFrom.mockImplementation(
      () =>
        ({
          insert: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'duplicate key value', code: '23505', details: '', hint: '' },
          }),
        }) as unknown as ReturnType<typeof supabase.from>
    );

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationCreateCajaEntry(), {
      wrapper: makeWrapper(qc),
    });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('DUPLICATE_ENTRY');
    }
  });
});
