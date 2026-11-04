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
import { onlineManager, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@shared/lib/i18n';
import { ok } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { createTestQueryClient } from '@shared/lib/test-utils';
import {
  fetchNearExpiryPricingDates,
  mapInventoryRow,
  inventoryKeys,
  useInventoryAlerts,
  useInventoryLog,
  useMutationAdjustInventory,
  useNearExpiryPricingDates,
} from './queries';

// ---------------------------------------------------------------------------
// Supabase mock handle
// ---------------------------------------------------------------------------

const settingsState = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@entities/settings', () => ({ useSettings: () => ({ data: settingsState.value }) }));

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
      p_idempotency_key: expect.any(String) as string,
    });
  });

  it('reuses the idempotency key if a failed attempt is retried, then mints a fresh one after success', async () => {
    const productId = crypto.randomUUID();
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    // A raised exception never reaches idempotency_commit, so retrying the
    // exact same adjustment with the same key is safe — no ledger row exists
    // yet to collide with.
    mockedRpc.mockResolvedValueOnce(rpcError('AUTH_FORBIDDEN: not allowed to adjust stock'));
    await result.current.mutateAsync({
      productId,
      quantityDelta: 5,
      reason: 'manual_adjustment',
      notes: undefined,
    });
    const keyAttempt1 = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key: string }).p_idempotency_key;
    expect(keyAttempt1).toBeTruthy();

    mockedRpc.mockResolvedValueOnce(rpcOk(15));
    await result.current.mutateAsync({
      productId,
      quantityDelta: 5,
      reason: 'manual_adjustment',
      notes: undefined,
    });
    const keyAttempt2 = (mockedRpc.mock.calls[1]?.[1] as { p_idempotency_key: string }).p_idempotency_key;
    expect(keyAttempt2).toBe(keyAttempt1);

    // The retry above succeeded, so the next (different) adjustment mints a
    // fresh key instead of reusing the committed one.
    mockedRpc.mockResolvedValueOnce(rpcOk(20));
    await result.current.mutateAsync({
      productId,
      quantityDelta: 2,
      reason: 'manual_adjustment',
      notes: undefined,
    });
    const keyAttempt3 = (mockedRpc.mock.calls[2]?.[1] as { p_idempotency_key: string }).p_idempotency_key;
    expect(keyAttempt3).not.toBe(keyAttempt1);
  });

  it('Fix-pass F5 (I1): mints a fresh key when a different adjustment on the same product follows a lost/failed one, even without a success in between', async () => {
    const productId = crypto.randomUUID();
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    // A manager submits -5 "waste" for this product; the response is lost (a
    // generic/unmapped error stands in for "network dropped the response"
    // here — the client cannot tell that apart from a real rejection).
    mockedRpc.mockResolvedValueOnce(rpcError('db exploded'));
    await result.current.mutateAsync({
      productId,
      quantityDelta: -5,
      reason: 'waste',
      notes: undefined,
    });
    const keyA = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key: string }).p_idempotency_key;
    expect(keyA).toBeTruthy();

    // A different adjustment on the SAME product (a different delta/reason —
    // e.g. the manager meant a second, separate -3 "expired" this time, or
    // the Batch Adjustment dialog's next submit) must never reuse the first
    // key: before this fix, the `??=` ref only cleared on success, so this
    // call would resend the same key under a different scope and the server
    // would raise IDEMPOTENCY_MISMATCH — and the *only* submit that would
    // "succeed" is an exact repeat of the original -5 "waste", applying
    // nothing and reporting a false "Stock updated".
    mockedRpc.mockResolvedValueOnce(rpcOk(3));
    const res = await result.current.mutateAsync({
      productId,
      quantityDelta: -3,
      reason: 'expired',
      notes: undefined,
    });
    expect(res.ok).toBe(true);
    const keyB = (mockedRpc.mock.calls[1]?.[1] as { p_idempotency_key: string }).p_idempotency_key;
    expect(keyB).not.toBe(keyA);
  });

  it('Fix-pass F5 (I1): maps an IDEMPOTENCY_* rejection to a dedicated translated error, discards the key, and invalidates inventory queries', async () => {
    const productId = crypto.randomUUID();
    mockedRpc.mockResolvedValueOnce(
      rpcError('IDEMPOTENCY_MISMATCH: key already used by a different operation')
    );

    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useMutationAdjustInventory(), {
      wrapper: makeWrapper(qc),
    });

    const res = await result.current.mutateAsync({
      productId,
      quantityDelta: -5,
      reason: 'waste',
      notes: undefined,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(res.error.message).toBe(i18n.t('entities:inventoryAdjust.idempotencyReplay'));
    }
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: [...inventoryKeys.all] as unknown[] })
    );

    // The key must have been discarded — an identical-fingerprint retry
    // mints a brand-new key instead of resending the poisoned one, which
    // would keep failing IDEMPOTENCY_MISMATCH forever.
    const firstKey = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key: string }).p_idempotency_key;
    mockedRpc.mockResolvedValueOnce(rpcOk(3));
    await result.current.mutateAsync({
      productId,
      quantityDelta: -5,
      reason: 'waste',
      notes: undefined,
    });
    const retryKey = (mockedRpc.mock.calls[1]?.[1] as { p_idempotency_key: string }).p_idempotency_key;
    expect(retryKey).not.toBe(firstKey);
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
      p_idempotency_key: expect.any(String) as string,
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

/** The query now ends in .order().range() and carries a count; `lte` stays the spy for its args and results. */
const paged = (lte: (...a: unknown[]) => unknown) =>
  (...a: unknown[]) => ({
    order: () => ({
      range: async () => {
        const r = (await lte(...a)) as { data: unknown; error: unknown };
        return { count: Array.isArray(r.data) ? r.data.length : null, ...r };
      },
    }),
  });

describe('fetchNearExpiryPricingDates (the near-expiry PRICING source)', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  function fakeClient(result: { data: unknown; error: unknown }) {
    const lte = vi.fn().mockResolvedValue(result);
    const select = vi.fn(() => ({ not: () => ({ lte: paged(lte) }) }));
    return { client: { from: vi.fn(() => ({ select })) } as never, lte, select };
  }

  it('reaches threshold + 8 days past the UTC date of the fetch, so a week-old cache still holds what is by then in the tier', async () => {
    const { client, lte } = fakeClient({ data: [], error: null });

    await fetchNearExpiryPricingDates(client, 14, new Date('2026-10-09T23:30:00Z'));

    // 2026-10-09 + 14 + 8 = 2026-10-31
    expect(lte).toHaveBeenCalledWith('expiry_date', '2026-10-31');
  });

  it('carries a product id and an expiry date only, no stock figure and no day count', async () => {
    const { client, select } = fakeClient({
      data: [{ product_id: id, expiry_date: '2026-10-23', quantity_on_hand: 4 }],
      error: null,
    });

    const res = await fetchNearExpiryPricingDates(client, 14, new Date('2026-10-09T12:00:00Z'));

    expect(select).toHaveBeenCalledWith('product_id, expiry_date', { count: 'exact' });
    expect(res).toEqual({ ok: true, data: [{ productId: id, expiryDate: '2026-10-23' }] });
  });

  it('returns the failure as a Result', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom', code: '500' } });
    const res = await fetchNearExpiryPricingDates(client, 14);
    expect(res.ok).toBe(false);
  });

  // The staff-facing lists (home, inventory tabs, sidebar badge, checkout notices) keep reading
  // useNearExpiryAlerts, whose query and cache entry are unchanged: the wider pricing list never
  // shares a cache key with it, so what staff see cannot change.
  it('the pricing list has its own cache key, distinct from the staff-facing near-expiry alerts', () => {
    expect(inventoryKeys.nearExpiryPricing(14)).not.toEqual(inventoryKeys.nearExpiry(14));
    expect(inventoryKeys.nearExpiry(14)).toEqual(['inventory', 'near-expiry', 14]);
  });
});

describe('useNearExpiryPricingDates', () => {
  const settingsWith = (thresholdDays: number) => ({ nearExpiry: { thresholdDays, discountPercent: 15 } });

  function cutoffs() {
    const lte = vi.fn().mockResolvedValue({ data: [], error: null });
    mockedFrom.mockImplementation(
      () =>
        ({ select: () => ({ not: () => ({ lte: paged(lte) }) }) }) as unknown as ReturnType<typeof supabase.from>
    );
    return lte;
  }
  const day = (iso: string, plus: number) =>
    new Date(Date.parse(iso) + plus * 86_400_000).toISOString().slice(0, 10);

  it('does not fetch with a fallback threshold before the settings have loaded', async () => {
    const lte = cutoffs();
    settingsState.value = undefined;
    renderHook(() => useNearExpiryPricingDates(), { wrapper: makeWrapper(createTestQueryClient()) });
    await new Promise(r => setTimeout(r, 20));
    expect(lte).not.toHaveBeenCalled();
  });

  // The threshold is part of the cache key, so a list fetched for another threshold is simply not
  // the entry the hook reads: it can never reach less far than the threshold in force.
  it('the near-expiry pricing list is refetched when the threshold changes', async () => {
    const lte = cutoffs();
    settingsState.value = settingsWith(14);
    const { rerender } = renderHook(() => useNearExpiryPricingDates(), {
      wrapper: makeWrapper(createTestQueryClient()),
    });
    await waitFor(() => { expect(lte).toHaveBeenCalledTimes(1); });
    const today = new Date().toISOString().slice(0, 10);
    expect(lte.mock.calls[0]?.[1]).toBe(day(today, 14 + 8));

    settingsState.value = settingsWith(40);
    rerender();

    await waitFor(() => { expect(lte).toHaveBeenCalledTimes(2); });
    expect(lte.mock.calls[1]?.[1]).toBe(day(today, 40 + 8));
  });

  const STALE = [{ productId: '33333333-3333-4333-8333-333333333333', expiryDate: '2026-10-23' }];

  it('a cached near-expiry list fetched for another threshold is not used for pricing', async () => {
    const lte = vi.fn().mockReturnValue(new Promise(() => undefined)); // the refetch never answers
    mockedFrom.mockImplementation(
      () => ({ select: () => ({ not: () => ({ lte: paged(lte) }) }) }) as unknown as ReturnType<typeof supabase.from>
    );
    const qc = createTestQueryClient();
    qc.setQueryData(inventoryKeys.nearExpiryPricing(14), ok(STALE));
    settingsState.value = settingsWith(40);

    const { result } = renderHook(() => useNearExpiryPricingDates(), { wrapper: makeWrapper(qc) });
    await waitFor(() => { expect(lte).toHaveBeenCalled(); });

    expect(result.current.data).toBeUndefined();
  });

  it('online, a threshold mismatch refetches the list', async () => {
    const lte = cutoffs();
    const qc = createTestQueryClient();
    qc.setQueryData(inventoryKeys.nearExpiryPricing(14), ok(STALE));
    settingsState.value = settingsWith(40);

    const { result } = renderHook(() => useNearExpiryPricingDates(), { wrapper: makeWrapper(qc) });

    await waitFor(() => { expect(result.current.data).toEqual([]); });
    const today = new Date().toISOString().slice(0, 10);
    expect(lte).toHaveBeenCalledTimes(1);
    expect(lte.mock.calls[0]?.[1]).toBe(day(today, 40 + 8));
  });

  it('offline, a threshold mismatch does not price from the stale list', async () => {
    const lte = cutoffs();
    const qc = createTestQueryClient();
    qc.setQueryData(inventoryKeys.nearExpiryPricing(14), ok(STALE));
    settingsState.value = settingsWith(40);
    onlineManager.setOnline(false);
    try {
      const { result } = renderHook(() => useNearExpiryPricingDates(), { wrapper: makeWrapper(qc) });
      await new Promise(r => setTimeout(r, 20));

      expect(result.current.data).toBeUndefined();
      expect(lte).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('a list fetched for the current threshold is used', async () => {
    cutoffs();
    const qc = createTestQueryClient();
    qc.setQueryData(inventoryKeys.nearExpiryPricing(40), ok(STALE));
    settingsState.value = settingsWith(40);

    const { result } = renderHook(() => useNearExpiryPricingDates(), { wrapper: makeWrapper(qc) });

    expect(result.current.data).toEqual(STALE);
  });
});

describe('mapInventoryRow', () => {
  // soldByWeight on the mapped product drives the grams/kg stock valuation: a dropped flag priced
  // weighed stock 1000x too high.
  const rowWith = (soldByWeight: boolean | null | undefined) =>
    ({
      id: '11111111-1111-4111-8111-111111111111',
      product_id: '22222222-2222-4222-8222-222222222222',
      quantity_on_hand: 5000,
      low_stock_threshold: 0,
      unit: 'g',
      updated_at: '2026-10-01T00:00:00.000Z',
      product: {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Loose rice',
        category_id: '00000000-0000-4000-8000-000000000001',
        base_price: 5,
        sku: 'RICE',
        is_active: true,
        image_url: null,
        stock_threshold: null,
        category: null,
        sold_by_weight: soldByWeight,
      },
    }) as unknown as Parameters<typeof mapInventoryRow>[0];

  it.each([
    [true, true],
    [false, false],
    [null, false],
    [undefined, false],
  ])('maps products.sold_by_weight %s to product.soldByWeight %s', (raw, expected) => {
    const res = mapInventoryRow(rowWith(raw));
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.product?.soldByWeight).toBe(expected);
  });
});
