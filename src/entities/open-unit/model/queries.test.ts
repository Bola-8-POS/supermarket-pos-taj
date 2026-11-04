/**
 * Unit tests for the open-unit entity: the read hook's row/error mapping and
 * the three RPC-backed mutation hooks' error-code mapping (27-05).
 */
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@shared/lib/supabase';
import { createTestQueryClient } from '@shared/lib/test-utils';
import {
  openUnitKeys,
  useMutationCorrectOpenUnit,
  useMutationOpenOpenUnit,
  useMutationVoidOpenUnit,
  useOpenUnits,
} from './queries';

// ---------------------------------------------------------------------------
// Supabase mock handles
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedFrom = vi.mocked(supabase).from;
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedRpc = vi.mocked(supabase).rpc;

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

/** `.from('open_units').select(...).order(...)[.eq(...)]` — chainable + thenable. */
function mockOpenUnitsChain(resolvedValue: { data: unknown; error: unknown }) {
  mockedFrom.mockImplementation(
    () =>
      ({
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (v: typeof resolvedValue) => void) => {
          resolve(resolvedValue);
        },
      }) as unknown as ReturnType<typeof supabase.from>
  );
}

function makeOpenUnitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    product_id: '22222222-2222-2222-2222-222222222222',
    remaining_count: 19,
    status: 'active',
    opened_by: '33333333-3333-3333-3333-333333333333',
    opened_at: '2026-07-30T10:00:00.000Z',
    closed_by: null,
    closed_at: null,
    closed_reason: null,
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-30T10:00:00.000Z',
    product: null,
    ...overrides,
  };
}

describe('useOpenUnits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a well-formed row into an OpenUnit with openedAt as a Date', async () => {
    mockOpenUnitsChain({ data: [makeOpenUnitRow()], error: null });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useOpenUnits(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data).toHaveLength(1);
    const unit = result.current.data?.[0];
    expect(unit?.status).toBe('active');
    expect(unit?.remainingCount).toBe(19);
    expect(unit?.openedAt).toBeInstanceOf(Date);
  });

  it('returns a resultError (never throws) when a row fails OpenUnitSchema validation', async () => {
    mockOpenUnitsChain({
      data: [makeOpenUnitRow({ remaining_count: -1 })],
      error: null,
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useOpenUnits(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.resultError).toBeDefined();
    });

    expect(result.current.data).toBeUndefined();
  });

  it('filters to active-only via .eq("status", "active") and uses openUnitKeys.active()', async () => {
    mockOpenUnitsChain({ data: [], error: null });

    const qc = createTestQueryClient();
    renderHook(() => useOpenUnits({ activeOnly: true }), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      const cache = qc.getQueryCache().findAll({ queryKey: openUnitKeys.active() });
      expect(cache.length).toBeGreaterThan(0);
    });
  });
});

describe('open-unit mutation hooks — RPC dispatch and error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useMutationOpenOpenUnit dispatches open_open_unit via db.rpc and invalidates on success', async () => {
    mockedRpc.mockResolvedValue({ data: 'new-unit-id', error: null } as never);

    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useMutationOpenOpenUnit(), { wrapper: makeWrapper(qc) });

    const res = await result.current.mutateAsync('product-1');

    expect(mockedRpc).toHaveBeenCalledWith('open_open_unit', { p_product_id: 'product-1' });
    expect(res).toEqual({ ok: true, data: 'new-unit-id' });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: openUnitKeys.all })
    );
  });

  it('maps a DUPLICATE_ENTRY RPC error verbatim (D-08 remaining-count text preserved)', async () => {
    const msg = 'DUPLICATE_ENTRY: an open unit already exists for this product (12 remaining) — sell through it first';
    mockedRpc.mockResolvedValue({ data: null, error: { message: msg } } as never);

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationOpenOpenUnit(), { wrapper: makeWrapper(qc) });

    const res = await result.current.mutateAsync('product-1');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('DUPLICATE_ENTRY');
      expect(res.error.message).toBe(msg);
    }
  });

  it('maps AUTH_FORBIDDEN / INVENTORY_NEGATIVE / VALIDATION_ERROR / NOT_FOUND / unknown RPC errors to the right AppErrorCode', async () => {
    const cases: Array<[string, string]> = [
      ['AUTH_FORBIDDEN: bartender or higher required to open a unit', 'AUTH_FORBIDDEN'],
      ['INVENTORY_NEGATIVE: no unopened package available for product x', 'INVENTORY_NEGATIVE'],
      ['VALIDATION_ERROR: product x is not configured for open units', 'VALIDATION_ERROR'],
      ['NOT_FOUND: open unit x does not exist', 'NOT_FOUND'],
      ['some totally unexpected database error', 'SUPABASE_ERROR'],
    ];

    for (const [msg, code] of cases) {
      mockedRpc.mockResolvedValue({ data: null, error: { message: msg } } as never);
      const qc = createTestQueryClient();
      const { result } = renderHook(() => useMutationOpenOpenUnit(), { wrapper: makeWrapper(qc) });
      const res = await result.current.mutateAsync('product-1');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(code);
        expect(res.error.message).toBe(msg);
      }
    }
  });

  it('useMutationCorrectOpenUnit parses input with OpenUnitCorrectionSchema then dispatches correct_open_unit', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationCorrectOpenUnit(), { wrapper: makeWrapper(qc) });

    const res = await result.current.mutateAsync({
      openUnitId: '11111111-1111-1111-1111-111111111111',
      remainingCount: 5,
      reason: 'recounted',
    });

    expect(res.ok).toBe(true);
    expect(mockedRpc).toHaveBeenCalledWith('correct_open_unit', {
      p_open_unit_id: '11111111-1111-1111-1111-111111111111',
      p_remaining_count: 5,
      p_reason: 'recounted',
    });
  });

  it('useMutationCorrectOpenUnit rejects a blank reason client-side before dispatching', async () => {
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationCorrectOpenUnit(), { wrapper: makeWrapper(qc) });

    const res = await result.current.mutateAsync({
      openUnitId: '11111111-1111-1111-1111-111111111111',
      remainingCount: 5,
      reason: '   ',
    });

    expect(res.ok).toBe(false);
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it('useMutationVoidOpenUnit dispatches void_open_unit with a trimmed reason', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationVoidOpenUnit(), { wrapper: makeWrapper(qc) });

    const res = await result.current.mutateAsync({
      openUnitId: '11111111-1111-1111-1111-111111111111',
      reason: '  damaged box  ',
    });

    expect(res.ok).toBe(true);
    expect(mockedRpc).toHaveBeenCalledWith('void_open_unit', {
      p_open_unit_id: '11111111-1111-1111-1111-111111111111',
      p_reason: 'damaged box',
    });
  });

  it('useMutationVoidOpenUnit rejects a blank reason client-side before dispatching', async () => {
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationVoidOpenUnit(), { wrapper: makeWrapper(qc) });

    const res = await result.current.mutateAsync({
      openUnitId: '11111111-1111-1111-1111-111111111111',
      reason: '',
    });

    expect(res.ok).toBe(false);
    expect(mockedRpc).not.toHaveBeenCalled();
  });
});
