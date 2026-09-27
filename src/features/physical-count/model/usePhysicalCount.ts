/* eslint-disable i18next/no-literal-string, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
   supabase.types.ts lags behind the adjust_inventory RPC (repo-wide cast pattern). */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { inventoryKeys } from '@entities/inventory';
import type { Inventory } from '@shared/lib/domain';
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
        const rpcRes = await supabaseMutation(() =>
          (supabase as any).rpc('adjust_inventory', {
            p_product_id: row.productId,
            p_quantity_delta: row.variance,
            p_reason: 'physical_count',
            p_notes: null,
            p_expected_quantity: row.expectedStock,
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
  };
}
