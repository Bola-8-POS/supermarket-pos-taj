/* eslint-disable i18next/no-literal-string, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
   supabase.types.ts lags behind the adjust_inventory RPC (repo-wide cast pattern). */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { inventoryKeys } from '@entities/inventory';
import type { Inventory } from '@shared/lib/domain';
import { generateIdempotencyKey } from '@shared/lib/domain-helpers';
import { logger } from '@shared/lib/logger-instance';
import { ok, supabaseMutation, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhysicalCountVarianceRow = {
  productId: string;
  productName: string;
  expectedStock: number;
  actualCount: number;
  /** positive = surplus, negative = shortage */
  variance: number;
};

export type PhysicalCountResult = {
  /** Only products where actual != expected and the adjustment applied */
  adjustedRows: PhysicalCountVarianceRow[];
  /** All products (for full variance display) */
  allRows: PhysicalCountVarianceRow[];
  /** Changed products whose adjustment did not apply (stock changed since the count started) */
  reportedRows: PhysicalCountVarianceRow[];
};

type PhysicalCountInput = {
  /** Map of productId → actual count entered by manager */
  entries: Map<string, number>;
  /** Current inventory snapshot (product name + expected stock) */
  inventory: Inventory[];
  staffId: string;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Submits a physical inventory count.
 *
 * For each product where actual != expected, writes a stock_movements entry
 * with reason='physical_count' and delta=(actual - expected), then updates
 * the inventory.quantity_on_hand.
 *
 * Returns a Result<PhysicalCountResult> with variance rows for display.
 */
export function usePhysicalCount() {
  const queryClient = useQueryClient();
  // One idempotency key per (product, expected stock, delta) triple, minted
  // once per changed row and reused if that exact same line is retried (a
  // submit that fails partway through), so a line that already applied
  // replays instead of double-applying when the user resubmits. Keying on
  // expected stock and delta too — not just productId — matters because the
  // ledger's scope hash includes p_quantity_delta: if the user edits a
  // product's counted value between submissions (still the same batch, same
  // hook instance, no remount) that product's delta changes, and reusing the
  // old key would replay a different logical adjustment under the same key
  // and raise IDEMPOTENCY_MISMATCH (fix round 1). Expected stock is also part
  // of the key because a later, unrelated count against the SAME product can
  // land on the SAME variance from a DIFFERENT starting stock level (e.g.
  // count 1: 10→8, variance -2; count 2, hours later: 8→6, variance -2 again)
  // — without expected stock in the key, that later count would silently
  // reuse the first count's already-committed key and replay a cached
  // "success" while applying nothing (opus-review-task-5.md I2, fix-pass
  // F5). Keying by `${productId}:${expectedStock}:${delta}` means any of
  // those three changing always mints a fresh key, while a genuine retry of
  // the identical line still reuses its committed/pending one. Cleared once
  // the batch completes without an early failure, AND whenever the count
  // dialog/session closes via `resetIdempotencyKeys()` (an abandoned partial
  // failure must not poison a later, unrelated count) — the next physical
  // count always starts with a clean map.
  const idempotencyKeysRef = useRef<Map<string, string>>(new Map());

  const mutation = useMutation({
    mutationFn: async (input: PhysicalCountInput): Promise<Result<PhysicalCountResult>> => {
      const { entries, inventory } = input;

      const allRows: PhysicalCountVarianceRow[] = inventory.map(item => {
        const actual = entries.get(item.productId) ?? item.quantityOnHand;
        return {
          productId: item.productId,
          productName: item.product?.name ?? 'Unknown',
          expectedStock: item.quantityOnHand,
          actualCount: actual,
          variance: actual - item.quantityOnHand,
        };
      });

      // Only rows where actual differs from expected need DB writes
      const changedRows = allRows.filter(row => row.variance !== 0);

      if (changedRows.length === 0) {
        logger.info('physical_count.no_changes', { total: allRows.length });
        return ok({ adjustedRows: [], allRows, reportedRows: [] });
      }

      logger.info('physical_count.submitting', {
        changed: changedRows.length,
        total: allRows.length,
      });

      // Process each changed product sequentially, through the adjust_inventory
      // RPC (locks the row, checks p_expected_quantity, writes the ledger and
      // audit rows together). p_expected_quantity is the stock level the count
      // screen showed when the count started (row.expectedStock), not a fresh
      // re-fetch — a mismatch means another write landed on this row mid-count.
      const adjustedRows: PhysicalCountVarianceRow[] = [];
      const reportedRows: PhysicalCountVarianceRow[] = [];

      for (const row of changedRows) {
        const lineKey = `${row.productId}:${String(row.expectedStock)}:${String(row.variance)}`;
        let key = idempotencyKeysRef.current.get(lineKey);
        if (!key) {
          key = generateIdempotencyKey('adjust_inventory');
          idempotencyKeysRef.current.set(lineKey, key);
        }
        const rpcRes = await supabaseMutation(() =>
          (supabase as any).rpc('adjust_inventory', {
            p_product_id: row.productId,
            p_quantity_delta: row.variance,
            p_reason: 'physical_count',
            p_notes: null,
            p_expected_quantity: row.expectedStock,
            p_idempotency_key: key,
          })
        );

        if (!rpcRes.ok) {
          if (rpcRes.error.message.includes('STOCK_CHANGED')) {
            logger.warn('physical_count.stock_changed', { productId: row.productId });
            reportedRows.push(row);
            continue;
          }
          logger.error('physical_count.adjust_failed', {
            productId: row.productId,
            message: rpcRes.error.message,
          });
          return rpcRes;
        }

        const data = rpcRes.data as { ok: boolean; quantityOnHand: number } | null;
        if (!data?.ok) {
          logger.error('physical_count.adjust_no_result', { productId: row.productId });
          reportedRows.push(row);
          continue;
        }
        adjustedRows.push(row);
      }

      logger.info('physical_count.success', {
        adjusted: adjustedRows.length,
        reported: reportedRows.length,
      });
      // Full batch success (reached the end of the loop rather than the
      // early `return rpcRes` failure path above) — clear the per-product
      // key map so the next physical count mints fresh keys instead of
      // colliding with this attempt's committed scope.
      idempotencyKeysRef.current.clear();
      return ok({ adjustedRows, allRows, reportedRows });
    },

    onSuccess: result => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.alerts() });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.lowStock() });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.log() });
    },
  });

  return {
    submitPhysicalCount: mutation.mutateAsync,
    isPending: mutation.isPending,
    reset: mutation.reset,
    /**
     * Clears the per-line idempotency-key map. Call this when the count
     * dialog/session closes — a batch abandoned after a partial failure
     * (early `return rpcRes` above, map not yet cleared) must not leave a
     * committed key behind for a later, unrelated count to collide with
     * (fix-pass F5, I2).
     */
    resetIdempotencyKeys: () => {
      idempotencyKeysRef.current.clear();
    },
  };
}
