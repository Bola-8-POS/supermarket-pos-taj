/**
 * Unit tests for usePhysicalCount
 *
 * AC covered (S8-04) plus wave 3a Task 2 changes:
 * - Success path: calls the adjust_inventory RPC per changed product with
 *   reason='physical_count', delta=(actual - expected) and
 *   p_expected_quantity = the baseline the count screen showed when the
 *   count started (not a live re-fetch)
 * - Products with actual == current (zero variance) are skipped — no RPC calls
 * - A STOCK_CHANGED rejection on one row is reported for that product and the
 *   loop continues to the remaining rows (Review Focus #3)
 * - Any other RPC failure still stops the whole submission (unchanged behavior)
 */

import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Inventory } from '@shared/lib/domain';
import { supabase } from '@shared/lib/supabase';
import { createTestQueryClient } from '@shared/lib/test-utils';
import { usePhysicalCount } from './usePhysicalCount';

// ---------------------------------------------------------------------------
// Supabase mock handle
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedRpc = vi.mocked(supabase.rpc);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

/**
 * Minimal Inventory fixture.
 * `product` is optional in the schema — include it so productName resolves.
 */
function makeInventoryItem(
  productId: string,
  productName: string,
  quantityOnHand: number
): Inventory {
  return {
    id: crypto.randomUUID(),
    productId,
    quantityOnHand,
    lowStockThreshold: 5,
    unit: 'unit',
    product: {
      id: productId,
      name: productName,
      categoryId: crypto.randomUUID(),
      basePrice: 500,
      happyHourPrice: null,
      sku: null,
      isActive: true,
      soldByWeight: false,
      imageUrl: null,
      photoPath: null,
      stock_threshold: null,
      unitsPerPackage: null,
      parentProductId: null,
      brandId: null,
      weightAmount: null,
      weightUnit: null,
      comboEligible: true,
      isCombo: false,
      modifiers: [],
    },
  };
}

function rpcOk(quantityOnHand: number) {
  return {
    data: { ok: true, quantityOnHand, movementId: crypto.randomUUID() },
    error: null,
  } as never;
}

function rpcError(message: string) {
  return { data: null, error: { message, code: 'P0001' } } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePhysicalCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Success path — changed rows
  // -------------------------------------------------------------------------

  it('S8-04: returns ok:true and adjustedRows when actual differs from expected', async () => {
    const productId = crypto.randomUUID();
    const inventory: Inventory[] = [makeInventoryItem(productId, 'Heineken', 10)];

    // actual = 7, so delta = 7 - 10 = -3
    mockedRpc.mockResolvedValueOnce(rpcOk(7));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), {
      wrapper: makeWrapper(qc),
    });

    const entries = new Map([[productId, 7]]);
    const res = await result.current.submitPhysicalCount({
      entries,
      inventory,
      staffId: 'staff-1',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.adjustedRows).toHaveLength(1);
    expect(res.data.reportedRows).toHaveLength(0);
    expect(res.data.adjustedRows[0]).toMatchObject({
      productId,
      productName: 'Heineken',
      expectedStock: 10,
      actualCount: 7,
      variance: -3,
    });
  });

  it('S8-04: calls adjust_inventory with reason=physical_count, the count delta and the count-start baseline', async () => {
    const productId = crypto.randomUUID();
    const inventory: Inventory[] = [makeInventoryItem(productId, 'Coke', 20)];

    mockedRpc.mockResolvedValueOnce(rpcOk(25));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    // actual=25, expected(baseline)=20 → delta=+5
    const entries = new Map([[productId, 25]]);
    const res = await result.current.submitPhysicalCount({
      entries,
      inventory,
      staffId: 'staff-42',
    });

    expect(res.ok).toBe(true);
    expect(mockedRpc).toHaveBeenCalledTimes(1);
    expect(mockedRpc).toHaveBeenCalledWith('adjust_inventory', {
      p_product_id: productId,
      p_quantity_delta: 5,
      p_reason: 'physical_count',
      p_notes: null,
      p_expected_quantity: 20,
      p_idempotency_key: expect.any(String) as string,
    });
  });

  // -------------------------------------------------------------------------
  // Skip unchanged rows
  // -------------------------------------------------------------------------

  it('S8-04: skips RPC calls for products where actual == expected (zero variance)', async () => {
    const productId = crypto.randomUUID();
    const inventory: Inventory[] = [makeInventoryItem(productId, 'Water', 15)];

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    // actual == expected (15 == 15) → should skip all RPC calls
    const entries = new Map([[productId, 15]]);
    const res = await result.current.submitPhysicalCount({
      entries,
      inventory,
      staffId: 'staff-1',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.adjustedRows).toHaveLength(0);
    expect(res.data.allRows).toHaveLength(1);
    expect(res.data.allRows[0]?.variance).toBe(0);
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it('S8-04: skips only unchanged rows and adjusts changed ones in a mixed list', async () => {
    const unchanged = crypto.randomUUID();
    const changed = crypto.randomUUID();

    const inventory: Inventory[] = [
      makeInventoryItem(unchanged, 'Beer', 10),
      makeInventoryItem(changed, 'Wine', 8),
    ];

    mockedRpc.mockResolvedValueOnce(rpcOk(5));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    const entries = new Map([
      [unchanged, 10], // same as expected → skip
      [changed, 5], // differs → adjust
    ]);

    const res = await result.current.submitPhysicalCount({
      entries,
      inventory,
      staffId: 'staff-1',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.adjustedRows).toHaveLength(1);
    expect(res.data.adjustedRows[0]?.productId).toBe(changed);
    expect(res.data.allRows).toHaveLength(2);
    expect(mockedRpc).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // STOCK_CHANGED: reported, loop continues (Review Focus #3)
  // -------------------------------------------------------------------------

  it('S8-04: a STOCK_CHANGED rejection on one of three rows is reported and the other two apply', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const c = crypto.randomUUID();
    const inventory: Inventory[] = [
      makeInventoryItem(a, 'A', 10),
      makeInventoryItem(b, 'B', 10),
      makeInventoryItem(c, 'C', 10),
    ];

    mockedRpc
      .mockResolvedValueOnce(rpcOk(8))
      .mockResolvedValueOnce(rpcError('STOCK_CHANGED: expected 10 but stock is 6'))
      .mockResolvedValueOnce(rpcOk(12));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    const entries = new Map([
      [a, 8],
      [b, 9],
      [c, 12],
    ]);
    const res = await result.current.submitPhysicalCount({
      entries,
      inventory,
      staffId: 'staff-1',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(mockedRpc).toHaveBeenCalledTimes(3);
    expect(res.data.adjustedRows.map(r => r.productId).sort()).toEqual([a, c].sort());
    expect(res.data.reportedRows).toHaveLength(1);
    expect(res.data.reportedRows[0]?.productId).toBe(b);
  });

  // -------------------------------------------------------------------------
  // Error path — a non-STOCK_CHANGED RPC failure still stops the submission
  // -------------------------------------------------------------------------

  it('S8-04: returns Result ok:false and stops the submission when the RPC refuses for another reason', async () => {
    const productId = crypto.randomUUID();
    const inventory: Inventory[] = [makeInventoryItem(productId, 'Rum', 10)];

    mockedRpc.mockResolvedValueOnce(rpcError('AUTH_FORBIDDEN: not allowed to adjust stock'));

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    const entries = new Map([[productId, 5]]); // differs from 10 → triggers the RPC
    const res = await result.current.submitPhysicalCount({
      entries,
      inventory,
      staffId: 'staff-1',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain('AUTH_FORBIDDEN');
  });

  // -------------------------------------------------------------------------
  // Idempotency key reuse across a retried batch (offline-first Plan 01, Task 5)
  // -------------------------------------------------------------------------

  it('reuses each product’s idempotency key across a retried batch, then mints fresh ones after a full success', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const inventory: Inventory[] = [makeInventoryItem(a, 'A', 10), makeInventoryItem(b, 'B', 10)];
    const entries = new Map([
      [a, 8],
      [b, 5],
    ]);

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    function keyFromCall(index: number): string {
      const args = mockedRpc.mock.calls[index]?.[1] as { p_idempotency_key: string };
      return args.p_idempotency_key;
    }

    // First attempt: A applies, B fails for a non-STOCK_CHANGED reason —
    // the submission stops there (matches the existing "stops the
    // submission" behavior above).
    mockedRpc
      .mockResolvedValueOnce(rpcOk(8))
      .mockResolvedValueOnce(rpcError('AUTH_FORBIDDEN: not allowed to adjust stock'));

    const first = await result.current.submitPhysicalCount({ entries, inventory, staffId: 'staff-1' });
    expect(first.ok).toBe(false);
    expect(mockedRpc).toHaveBeenCalledTimes(2);
    const keyA1 = keyFromCall(0);
    const keyB1 = keyFromCall(1);
    expect(keyA1).toBeTruthy();
    expect(keyB1).toBeTruthy();

    // Retry of the SAME batch (same entries/inventory): both products must
    // reuse the same keys as the first attempt, so A's already-applied line
    // replays via the ledger instead of double-applying.
    mockedRpc.mockResolvedValueOnce(rpcOk(8)).mockResolvedValueOnce(rpcOk(5));
    const second = await result.current.submitPhysicalCount({ entries, inventory, staffId: 'staff-1' });
    expect(second.ok).toBe(true);
    expect(mockedRpc).toHaveBeenCalledTimes(4);
    expect(keyFromCall(2)).toBe(keyA1);
    expect(keyFromCall(3)).toBe(keyB1);

    // A brand-new count attempt after that full success mints a fresh key
    // for the same product rather than colliding with the committed one.
    mockedRpc.mockResolvedValueOnce(rpcOk(3));
    const thirdEntries = new Map([[a, 3]]);
    await result.current.submitPhysicalCount({ entries: thirdEntries, inventory, staffId: 'staff-1' });
    expect(keyFromCall(4)).not.toBe(keyA1);
  });

  it('Fix round 1: mints a fresh key for an edited line on retry, but reuses the key for an unedited line', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const inventory: Inventory[] = [makeInventoryItem(a, 'A', 10), makeInventoryItem(b, 'B', 10)];

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    function keyFromCall(index: number): string {
      const args = mockedRpc.mock.calls[index]?.[1] as { p_idempotency_key: string };
      return args.p_idempotency_key;
    }

    // First attempt: A (delta -2) applies, B (delta -5) hard-fails with a
    // non-STOCK_CHANGED error — the batch stops before B's key is ever
    // committed, and the map is never cleared (no full-success return).
    const firstEntries = new Map([
      [a, 8],
      [b, 5],
    ]);
    mockedRpc
      .mockResolvedValueOnce(rpcOk(8))
      .mockResolvedValueOnce(rpcError('AUTH_FORBIDDEN: not allowed to adjust stock'));

    const first = await result.current.submitPhysicalCount({ entries: firstEntries, inventory, staffId: 'staff-1' });
    expect(first.ok).toBe(false);
    const keyA1 = keyFromCall(0);
    const keyB1 = keyFromCall(1);

    // Retry: the user corrects A's counted value (now delta -3 instead of
    // -2) but leaves B's counted value alone (still delta -5). Per the
    // ledger's scope hash (product + delta + reason), reusing A's old key
    // under a different delta would raise IDEMPOTENCY_MISMATCH — so A must
    // get a brand-new key. B's line is unedited, so it must reuse its
    // original key so a genuine retry of B still replays/applies once.
    const retryEntries = new Map([
      [a, 7], // delta now -3 (was -2)
      [b, 5], // delta still -5 (unchanged)
    ]);
    mockedRpc.mockResolvedValueOnce(rpcOk(7)).mockResolvedValueOnce(rpcOk(5));
    const retry = await result.current.submitPhysicalCount({ entries: retryEntries, inventory, staffId: 'staff-1' });
    expect(retry.ok).toBe(true);
    expect(mockedRpc).toHaveBeenCalledTimes(4);

    const keyA2 = keyFromCall(2);
    const keyB2 = keyFromCall(3);
    expect(keyA2).not.toBe(keyA1);
    expect(keyB2).toBe(keyB1);
  });

  it('Fix round 2 (I2): an abandoned batch followed by a later count with the same variance but different expected stock mints a fresh key and actually applies', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    function keyFromCall(index: number): string {
      const args = mockedRpc.mock.calls[index]?.[1] as { p_idempotency_key: string };
      return args.p_idempotency_key;
    }

    // Count 1: A shows 10 on hand, counted 8 (variance -2, expectedStock 10).
    // B hard-fails with a non-STOCK_CHANGED error, so the batch stops before
    // reaching the end of the loop — the map is never cleared, and the
    // manager abandons the count (closes the dialog) without retrying.
    const firstInventory: Inventory[] = [makeInventoryItem(a, 'A', 10), makeInventoryItem(b, 'B', 10)];
    const firstEntries = new Map([
      [a, 8],
      [b, 5],
    ]);
    mockedRpc
      .mockResolvedValueOnce(rpcOk(8))
      .mockResolvedValueOnce(rpcError('AUTH_FORBIDDEN: not allowed to adjust stock'));

    const first = await result.current.submitPhysicalCount({
      entries: firstEntries,
      inventory: firstInventory,
      staffId: 'staff-1',
    });
    expect(first.ok).toBe(false);
    const keyA1 = keyFromCall(0);
    expect(keyA1).toBeTruthy();

    // Later in the same shift: real stock movement means A now shows 8 on
    // hand (not 10), and is counted 6 — variance is -2 again, matching the
    // abandoned attempt's variance exactly, but the starting stock differs.
    // Without expected stock in the key, this would reuse keyA1 and the
    // server would silently replay the cached "success" (idempotent:true)
    // while applying nothing. With it, this must mint a brand-new key and
    // the RPC must actually be called (not skipped as an already-committed
    // replay).
    const secondInventory: Inventory[] = [makeInventoryItem(a, 'A', 8), makeInventoryItem(b, 'B', 10)];
    const secondEntries = new Map([[a, 6]]);
    mockedRpc.mockResolvedValueOnce(rpcOk(6));

    const second = await result.current.submitPhysicalCount({
      entries: secondEntries,
      inventory: secondInventory,
      staffId: 'staff-1',
    });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.adjustedRows).toHaveLength(1);
    }
    expect(mockedRpc).toHaveBeenCalledTimes(3);
    const keyA2 = keyFromCall(2);
    expect(keyA2).not.toBe(keyA1);
    expect(mockedRpc).toHaveBeenNthCalledWith(3, 'adjust_inventory', {
      p_product_id: a,
      p_quantity_delta: -2,
      p_reason: 'physical_count',
      p_notes: null,
      p_expected_quantity: 8,
      p_idempotency_key: keyA2,
    });
  });

  it('Fix round 2 (I2): resetIdempotencyKeys() clears the map so a genuinely identical retry after an abandoned batch still mints a fresh key', async () => {
    const a = crypto.randomUUID();
    const inventory: Inventory[] = [makeInventoryItem(a, 'A', 10)];
    const entries = new Map([[a, 8]]); // variance -2

    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });

    function keyFromCall(index: number): string {
      const args = mockedRpc.mock.calls[index]?.[1] as { p_idempotency_key: string };
      return args.p_idempotency_key;
    }

    mockedRpc.mockResolvedValueOnce(rpcError('AUTH_FORBIDDEN: not allowed to adjust stock'));
    const first = await result.current.submitPhysicalCount({ entries, inventory, staffId: 'staff-1' });
    expect(first.ok).toBe(false);
    const keyA1 = keyFromCall(0);

    // The dialog is closed (abandoned) — this must clear the pending key.
    result.current.resetIdempotencyKeys();

    // Even an identical retry (same product, same expected stock, same
    // variance) now mints a fresh key rather than reusing the abandoned
    // attempt's.
    mockedRpc.mockResolvedValueOnce(rpcOk(8));
    await result.current.submitPhysicalCount({ entries, inventory, staffId: 'staff-1' });
    expect(keyFromCall(1)).not.toBe(keyA1);
  });

  // -------------------------------------------------------------------------
  // isPending state
  // -------------------------------------------------------------------------

  it('isPending is false before mutation fires', () => {
    const qc = createTestQueryClient();
    const { result } = renderHook(() => usePhysicalCount(), { wrapper: makeWrapper(qc) });
    expect(result.current.isPending).toBe(false);
  });
});
