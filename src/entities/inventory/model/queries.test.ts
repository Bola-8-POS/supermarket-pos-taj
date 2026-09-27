/**
 * Unit tests for useInventoryAlerts() and useInventoryLog()
 *
 * AC:
 * - S8-02-AC1: returns all products where current stock <= stock_threshold
 * - S8-02-AC3: returns Result<InventoryAlert[]> with productName, currentStock, threshold
 * - error branch: returns Result with ok:false on Supabase failure
 * - regression: useInventoryLog() must not drop stock_movements rows whose
 *   `reason` is outside the narrow InventoryAdjustReason enum (notably 'refund')
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
  inventoryKeys,
  useInventoryAlerts,
  useInventoryLog,
  useMutationAdjustInventory,
} from './queries';

// ---------------------------------------------------------------------------
// Supabase mock handle
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedFrom = vi.mocked(supabase).from;
// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedRpc = vi.mocked(supabase).rpc;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

/**
 * The hook calls .from().select().not() — three chained calls, then awaits.
 * `.not()` must be thenable so the hook can await the query result.
 */
function mockInventoryAlertsChain(resolvedValue: { data: unknown; error: unknown }) {
  mockedFrom.mockImplementation(
    () =>
      ({
        select: vi.fn().mockReturnThis(),
        not: vi.fn().mockResolvedValue(resolvedValue),
      }) as unknown as ReturnType<typeof supabase.from>
  );
}

// ---------------------------------------------------------------------------
// Raw DB row factory
// ---------------------------------------------------------------------------

function makeAlertRow(
  productId: string,
  productName: string,
  quantityOnHand: number,
  stockThreshold: number
) {
  return {
    quantity_on_hand: quantityOnHand,
    product: {
      id: productId,
      name: productName,
      stock_threshold: stockThreshold,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useInventoryAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC1 + AC3: success — returns only products at or below threshold
  // -------------------------------------------------------------------------

  it('S8-02-AC1: returns products where stock <= threshold and omits products above threshold', async () => {
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    const p3 = crypto.randomUUID();

    mockInventoryAlertsChain({
      data: [
        makeAlertRow(p1, 'Heineken', 2, 5), // at risk: 2 <= 5 ✓
        makeAlertRow(p2, 'Coke', 5, 5), // exactly at threshold: 5 <= 5 ✓
        makeAlertRow(p3, 'Water', 10, 5), // above threshold: 10 > 5 — excluded
      ],
      error: null,
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryAlerts(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.map(a => a.productId)).toContain(p1);
    expect(result.current.data?.map(a => a.productId)).toContain(p2);
    expect(result.current.data?.map(a => a.productId)).not.toContain(p3);
  });

  it('S8-02-AC3: returned InventoryAlert objects include productName, currentStock, and threshold', async () => {
    const pid = crypto.randomUUID();

    mockInventoryAlertsChain({
      data: [makeAlertRow(pid, 'Amstel', 3, 10)],
      error: null,
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryAlerts(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data).toHaveLength(1);
    const alert = result.current.data?.[0];
    expect(alert).toMatchObject({
      productId: pid,
      productName: 'Amstel',
      currentStock: 3,
      threshold: 10,
    });
  });

  it('returns an empty array when no products breach their threshold', async () => {
    mockInventoryAlertsChain({
      data: [makeAlertRow(crypto.randomUUID(), 'Beer', 50, 5)],
      error: null,
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryAlerts(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.isEmpty).toBe(true);
    });

    expect(result.current.data).toHaveLength(0);
  });

  it('returns an empty array when Supabase returns no rows (all thresholds null — filtered server-side)', async () => {
    mockInventoryAlertsChain({ data: [], error: null });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryAlerts(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Error branch
  // -------------------------------------------------------------------------

  it('returns Result with ok:false when Supabase returns an error', async () => {
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn().mockReturnThis(),
          not: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'connection refused', code: '500' },
          }),
        }) as unknown as ReturnType<typeof supabase.from>
    );

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryAlerts(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      // data from the raw query is the Result — check resultError is populated
      expect(result.current.resultError).toBeDefined();
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.resultError?.code).toBe('SUPABASE_ERROR');
  });

  // -------------------------------------------------------------------------
  // Query key
  // -------------------------------------------------------------------------

  it('uses inventoryKeys.alerts() as the query key', () => {
    expect(inventoryKeys.alerts()).toEqual(['inventory', 'alerts']);
  });

  // -------------------------------------------------------------------------
  // staleTime
  // -------------------------------------------------------------------------

  it('is configured with staleTime of 30 000ms', () => {
    mockInventoryAlertsChain({ data: [], error: null });

    const qc = createTestQueryClient();
    renderHook(() => useInventoryAlerts(), { wrapper: makeWrapper(qc) });

    const cache = qc.getQueryCache().findAll({ queryKey: inventoryKeys.alerts() });
    expect(cache.length).toBeGreaterThan(0);
    // staleTime is stored on the observer options
    expect(cache[0]?.observers[0]?.options.staleTime).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// useInventoryLog — stock_movements ledger
// ---------------------------------------------------------------------------

/**
 * The hook calls .from().select().order().limit() and awaits the result of
 * .limit() directly (no productId filter), so .limit() must be the thenable.
 */
function mockStockMovementsChain(resolvedValue: { data: unknown; error: unknown }) {
  mockedFrom.mockImplementation(
    () =>
      ({
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(resolvedValue),
      }) as unknown as ReturnType<typeof supabase.from>
  );
}

function makeMovementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    product_id: crypto.randomUUID(),
    quantity_delta: -1,
    reason: 'sale',
    staff_id: crypto.randomUUID(),
    created_at: new Date('2026-09-01T10:00:00Z').toISOString(),
    ...overrides,
  };
}

describe('useInventoryLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Regression: a reason='refund' row must survive parsing.
  //
  // Oracle: specified — domain.ts declares StockMovementSchema (whose reason is
  // StockMovementReasonSchema, including 'refund') as the schema for the
  // stock_movements table, and the restore_inventory_on_refund_item trigger
  // writes reason='refund' rows on every refund. Parsing the table with the
  // narrower InventoryLogSchema threw, and the throw aborted the whole batch.
  // -------------------------------------------------------------------------

  it('keeps a stock_movements row with reason="refund" instead of dropping the whole batch', async () => {
    const refundId = crypto.randomUUID();
    const saleId = crypto.randomUUID();
    const expiredId = crypto.randomUUID();

    mockStockMovementsChain({
      data: [
        makeMovementRow({ id: saleId, reason: 'sale' }),
        // reason boundary: 'expired' is the last member of the narrow
        // InventoryAdjustReason enum, 'refund' is only in the wider
        // StockMovementReason enum — both are valid stock_movements values.
        makeMovementRow({ id: expiredId, reason: 'expired' }),
        makeMovementRow({ id: refundId, reason: 'refund', quantity_delta: 2 }),
      ],
      error: null,
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryLog(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.resultError).toBeUndefined();
    expect(result.current.data?.map(l => l.id)).toEqual([saleId, expiredId, refundId]);
    expect(result.current.data?.find(l => l.id === refundId)).toMatchObject({
      reason: 'refund',
      quantityDelta: 2,
    });
  });

  it('keeps a row whose product_id is null (ingredient-only movement)', async () => {
    const nullProductId = crypto.randomUUID();

    mockStockMovementsChain({
      data: [makeMovementRow({ id: nullProductId, product_id: null, reason: 'correction' })],
      error: null,
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryLog(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.productId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The other half of the root cause: one genuinely-unparseable row must not
  // take the rest of the batch (or the error surface) down with it.
  // -------------------------------------------------------------------------

  it('skips a genuinely malformed row without discarding the valid rows', async () => {
    const goodId = crypto.randomUUID();

    mockStockMovementsChain({
      data: [
        makeMovementRow({ id: goodId }),
        makeMovementRow({ reason: 'not_a_real_reason' }),
        makeMovementRow({ id: 'not-a-uuid' }),
      ],
      error: null,
    });

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryLog(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.resultError).toBeUndefined();
    expect(result.current.data?.map(l => l.id)).toEqual([goodId]);
  });

  it('surfaces resultError when the fetch itself fails', async () => {
    mockedFrom.mockImplementation(
      () =>
        ({
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'connection refused', code: '500' },
          }),
        }) as unknown as ReturnType<typeof supabase.from>
    );

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useInventoryLog(), { wrapper: makeWrapper(qc) });

    await waitFor(() => {
      expect(result.current.resultError).toBeDefined();
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.resultError?.code).toBe('SUPABASE_ERROR');
  });
});

// ---------------------------------------------------------------------------
// useMutationAdjustInventory — one adjust_inventory RPC call (wave 3a)
// ---------------------------------------------------------------------------

function rpcOk(quantityOnHand: number, movementId = crypto.randomUUID()) {
  return { data: { ok: true, quantityOnHand, movementId }, error: null } as never;
}

function rpcError(message: string) {
  return { data: null, error: { message, code: 'P0001' } } as never;
}

describe('useMutationAdjustInventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls adjust_inventory with the exact argument object, p_notes null when notes is absent', async () => {
    const productId = crypto.randomUUID();
    mockedRpc.mockResolvedValueOnce(rpcOk(12));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    await result.current.mutateAsync({
      productId,
      quantityDelta: 5,
      reason: 'manual_adjustment',
      notes: undefined,
    });

    expect(mockedRpc).toHaveBeenCalledTimes(1);
    expect(mockedRpc).toHaveBeenCalledWith('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: 5,
      p_reason: 'manual_adjustment',
      p_notes: null,
      p_expected_quantity: null,
    });
  });

  it('forwards a provided notes value as p_notes', async () => {
    const productId = crypto.randomUUID();
    mockedRpc.mockResolvedValueOnce(rpcOk(12));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    await result.current.mutateAsync({
      productId,
      quantityDelta: -2,
      reason: 'waste',
      notes: 'dropped a case',
    });

    expect(mockedRpc).toHaveBeenCalledWith('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: -2,
      p_reason: 'waste',
      p_notes: 'dropped a case',
      p_expected_quantity: null,
    });
  });

  it('maps a successful RPC response to { quantityOnHand, movementId }', async () => {
    const movementId = crypto.randomUUID();
    mockedRpc.mockResolvedValueOnce(rpcOk(7, movementId));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    const res = await result.current.mutateAsync({
      productId: crypto.randomUUID(),
      quantityDelta: 1,
      reason: 'manual_adjustment',
      notes: undefined,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ quantityOnHand: 7, movementId });
  });

  it.each([
    ['AUTH_FORBIDDEN: not allowed to adjust stock', 'AUTH_FORBIDDEN'],
    ['INVALID_DELTA: quantity delta must be non-zero', 'INVALID_DELTA'],
    ['INVALID_REASON: a reason is required', 'INVALID_REASON'],
    ['NOT_FOUND: no stock row for product x', 'NOT_FOUND'],
    ['STOCK_CHANGED: expected 10 but stock is 6', 'STOCK_CHANGED'],
  ] as const)('maps a %s error message to code %s', async (message, code) => {
    mockedRpc.mockResolvedValueOnce(rpcError(message));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    const res = await result.current.mutateAsync({
      productId: crypto.randomUUID(),
      quantityDelta: 1,
      reason: 'manual_adjustment',
      notes: undefined,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(code);
    expect(res.error.message).toBe(message);
  });

  it('maps a quantity_on_hand_non_negative check-constraint failure to INVENTORY_NEGATIVE', async () => {
    // Not an RPC-raised custom message (those default to SQLSTATE P0001 and
    // survive parseSupabaseError untouched, like the five cases above) —
    // this is the UPDATE inside adjust_inventory itself hitting the
    // inventory table's own CHECK constraint, SQLSTATE 23514.
    // parseSupabaseError turns that into a generic VALIDATION_ERROR whose
    // `.message` is a fixed "Please check the highlighted fields." string
    // and whose `.detail` carries the original constraint text.
    mockedRpc.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'new row for relation "inventory" violates check constraint "quantity_on_hand_non_negative"',
        code: '23514',
      },
    } as never);

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    const res = await result.current.mutateAsync({
      productId: crypto.randomUUID(),
      quantityDelta: -100,
      reason: 'manual_adjustment',
      notes: undefined,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INVENTORY_NEGATIVE');
  });

  it('passes an unmatched error through unchanged (no five-way prefix match)', async () => {
    mockedRpc.mockResolvedValueOnce(rpcError('some other database failure'));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    const res = await result.current.mutateAsync({
      productId: crypto.randomUUID(),
      quantityDelta: 1,
      reason: 'manual_adjustment',
      notes: undefined,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Not one of the five mapped codes — the generic Supabase classification survives.
    expect(res.error.code).toBe('SUPABASE_ERROR');
    expect(res.error.message).toBe('some other database failure');
  });
});
