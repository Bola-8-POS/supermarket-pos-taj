/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Inventory analytics report queries (Phase 14 — Valuation, Shrinkage/Waste,
 * Expiry-Loss, Turnover). Kept in a sibling file to queries.ts, mirroring
 * entities/tab/model/queries-reports.ts's sibling-file convention.
 */
/* eslint-disable i18next/no-literal-string -- query-key namespace strings +
   multi-line Supabase chain args below are wire-protocol identifiers, not UI
   copy (same rationale as entities/tab/model/queries-reports.ts); genuine
   user-facing report fallback labels are translated via i18n.t() below
   regardless of this disable. */

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, unknownError, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

const db = supabase as any;

const RawStockMovementDeltaSchema = z.object({
  productId: z.string(),
  deltaSum: z.number(),
});

/**
 * Fetches each product's SUMMED quantity_delta for stock_movements after
 * `asOf` via the bounded get_stock_movement_deltas_after RPC (D-27
 * follow-up) — replaces fetching every raw movement row (unbounded on both
 * row count and time range; the empirically-reproduced instance of
 * WINDOWS #27's PostgREST row-cap class). Returns one synthetic
 * MovementForReconstruction per product (createdAt = asOf + 1ms, guaranteed
 * to satisfy computeInventoryValueAsOf's `createdAt > asOfDate` filter) so
 * the existing, already-unit-tested computeInventoryValueAsOf pure function
 * is reused completely unchanged — only the data source is bounded now.
 */
async function fetchDeltaMovementsAfter(
  asOf: Date
): Promise<Result<MovementForReconstruction[]>> {
  const { data, error } = await db.rpc('get_stock_movement_deltas_after', {
    p_after: asOf.toISOString(),
  });

  if (error) {
    logger.error('reports.stock_movement_deltas.fetch_failed', { message: error.message });
    return err(unknownError(error));
  }

  const parsed = data as { ok: boolean; rows?: unknown[] } | null;
  if (!parsed?.ok) {
    return err(unknownError('get_stock_movement_deltas_after returned ok:false'));
  }

  try {
    const syntheticCreatedAt = new Date(asOf.getTime() + 1);
    const movements: MovementForReconstruction[] = (parsed.rows ?? []).map(raw => {
      const row = RawStockMovementDeltaSchema.parse(raw);
      return {
        productId: row.productId,
        quantityDelta: row.deltaSum,
        createdAt: syntheticCreatedAt,
      };
    });
    return ok(movements);
  } catch (e) {
    return err(unknownError(e));
  }
}

const RawStockMovementTwoCutoffDeltaSchema = z.object({
  productId: z.string(),
  deltaSumFrom: z.number(),
  deltaSumTo: z.number(),
});

/**
 * Turnover-specific sibling of fetchDeltaMovementsAfter: fetches BOTH
 * cutoffs' summed deltas in a single bounded RPC call
 * (get_stock_movement_deltas_two_cutoffs) instead of two separate calls —
 * restores this page's original one-round-trip shape (movements after
 * `from` is a superset of movements after `to`, so the pre-fix code fetched
 * once and reused the raw rows for both reconstructions) while staying
 * fully bounded. Returns two synthetic-movement arrays, one per cutoff, for
 * computeInventoryValueAsOf.
 */
async function fetchDeltaMovementsTwoCutoffs(
  from: Date,
  to: Date
): Promise<
  Result<{ atFrom: MovementForReconstruction[]; atTo: MovementForReconstruction[] }>
> {
  const { data, error } = await db.rpc('get_stock_movement_deltas_two_cutoffs', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });

  if (error) {
    logger.error('reports.turnover.fetch_failed', { message: error.message });
    return err(unknownError(error));
  }

  const parsed = data as { ok: boolean; rows?: unknown[] } | null;
  if (!parsed?.ok) {
    return err(unknownError('get_stock_movement_deltas_two_cutoffs returned ok:false'));
  }

  try {
    const syntheticAtFrom = new Date(from.getTime() + 1);
    const syntheticAtTo = new Date(to.getTime() + 1);
    const atFrom: MovementForReconstruction[] = [];
    const atTo: MovementForReconstruction[] = [];
    for (const raw of parsed.rows ?? []) {
      const row = RawStockMovementTwoCutoffDeltaSchema.parse(raw);
      atFrom.push({
        productId: row.productId,
        quantityDelta: row.deltaSumFrom,
        createdAt: syntheticAtFrom,
      });
      atTo.push({
        productId: row.productId,
        quantityDelta: row.deltaSumTo,
        createdAt: syntheticAtTo,
      });
    }
    return ok({ atFrom, atTo });
  } catch (e) {
    return err(unknownError(e));
  }
}

// ============================================================================
// PATTERN 1 (D-04): shared "value as of date" reconstruction, reused by
// Valuation (this plan) and Turnover (14-04).
// ============================================================================

export type CurrentStock = {
  productId: string;
  quantityOnHand: number;
  costPrice: number | null;
};

export type MovementForReconstruction = {
  productId: string;
  quantityDelta: number;
  createdAt: Date;
};

export type ValuationReconstructedRow = {
  productId: string;
  quantityAsOf: number;
  costPrice: number | null;
  value: number | null;
};

/**
 * Reconstructs on-hand quantity as of `asOfDate` by subtracting all movements
 * that happened strictly AFTER asOfDate from the current quantity_on_hand.
 * Values the reconstructed quantity at CURRENT cost (D-03) — stock_movements
 * has no per-movement cost snapshot, so there is no historical cost to use.
 * Pure function — safe to call repeatedly with the same input (idempotent).
 */
export function computeInventoryValueAsOf(
  current: CurrentStock[],
  movementsAfterCutoff: MovementForReconstruction[],
  asOfDate: Date
): ValuationReconstructedRow[] {
  const deltasByProduct = new Map<string, number>();
  for (const m of movementsAfterCutoff) {
    if (m.createdAt <= asOfDate) continue; // defensive; caller should pre-filter
    deltasByProduct.set(m.productId, (deltasByProduct.get(m.productId) ?? 0) + m.quantityDelta);
  }
  return current.map(row => {
    const laterDelta = deltasByProduct.get(row.productId) ?? 0;
    const quantityAsOf = row.quantityOnHand - laterDelta;
    const value =
      row.costPrice === null ? null : Math.round(quantityAsOf * row.costPrice * 100) / 100;
    return { productId: row.productId, quantityAsOf, costPrice: row.costPrice, value };
  });
}

// ============================================================================
// VALUATION REPORT (INVR-01)
// ============================================================================

export type ValuationRow = ValuationReconstructedRow & {
  productName: string;
  categoryName: string;
};

type InventoryValuationRawRow = {
  product_id: string;
  quantity_on_hand: number;
  cost_price: number | null;
  product: { name: string; category: { name: string } | null } | null;
};

/**
 * Fetches current on-hand stock + movements after `asOfDate`, reconstructs
 * quantity/value via computeInventoryValueAsOf (D-04), and re-attaches
 * product/category names for display. D-05: the Reports page's shared
 * DateRangePicker applies to Valuation as "as of end date" — callers pass
 * `dateRange.to`, never a from/to pair.
 */
export function useInventoryValuationReport(asOfDate: Date) {
  return useQuery({
    queryKey: ['reports', 'inventory-valuation', asOfDate.toISOString()] as const,
    queryFn: async (): Promise<Result<ValuationRow[]>> => {
      const { data: invData, error: invError } = await db.from('inventory').select(`
          product_id, quantity_on_hand, cost_price,
          product:products(name, category:categories(name))
        `);

      if (invError) {
        logger.error('reports.inventory_valuation.fetch_failed', { message: invError.message });
        return err(unknownError(invError));
      }

      const movResult = await fetchDeltaMovementsAfter(asOfDate);
      if (!movResult.ok) return movResult;

      const invRows: InventoryValuationRawRow[] = Array.isArray(invData) ? invData : [];

      const current: CurrentStock[] = invRows.map(r => ({
        productId: r.product_id,
        quantityOnHand: r.quantity_on_hand,
        costPrice: r.cost_price,
      }));

      const reconstructed = computeInventoryValueAsOf(current, movResult.data, asOfDate);

      const namesByProduct = new Map<string, { productName: string; categoryName: string }>(
        invRows.map(r => [
          r.product_id,
          {
            productName: r.product?.name ?? i18n.t('entities:reports.unknownProduct'),
            categoryName: r.product?.category?.name ?? i18n.t('entities:reports.uncategorized'),
          },
        ])
      );

      const rows: ValuationRow[] = reconstructed.map(r => {
        const names = namesByProduct.get(r.productId);
        return {
          ...r,
          productName: names?.productName ?? i18n.t('entities:reports.unknownProduct'),
          categoryName: names?.categoryName ?? i18n.t('entities:reports.uncategorized'),
        };
      });

      return ok(rows);
    },
    staleTime: 60_000,
  });
}

// ============================================================================
// PATTERN 2: SHRINKAGE/WASTE (INVR-02) + EXPIRY-LOSS (INVR-03)
// ============================================================================

const LOSS_REASONS = ['waste', 'correction', 'expired'] as const;
// Pre-Phase-14 rows (created before the reason picker existed) are ALL
// 'manual_adjustment' — D-02 requires these bucketed separately, never
// guessed at as waste or expired.
const UNCLASSIFIED_REASON = 'manual_adjustment';

export type ShrinkageMovement = {
  productId: string;
  quantityDelta: number;
  reason: string;
  costPrice: number | null;
  createdAt: Date;
};

export type ShrinkageBucket = { units: number; value: number };

/**
 * GROUP BY reason over stock_movements rows, loss only (negative delta).
 * 'waste'/'correction'/'expired' each get their own bucket key; the legacy
 * 'manual_adjustment' reason (pre-Phase-14, before the reason picker
 * existed) is bucketed under 'unclassified_adjustments' (D-02) — never
 * silently folded into waste or expired. 'sale'/'refund'/anything else is
 * excluded entirely (not stock loss). Pure function — safe to call
 * repeatedly with the same input (idempotent).
 */
export function groupShrinkageByReason(movements: ShrinkageMovement[]): Map<string, ShrinkageBucket> {
  const byReason = new Map<string, ShrinkageBucket>();
  for (const m of movements) {
    if (m.quantityDelta >= 0) continue; // shrinkage is loss only, never a positive delta
    const bucket = (LOSS_REASONS as readonly string[]).includes(m.reason)
      ? m.reason
      : m.reason === UNCLASSIFIED_REASON
        ? 'unclassified_adjustments' // D-02
        : null; // 'sale', 'refund', 'delivery', 'physical_count', dead bar-pos values — not shrinkage
    if (bucket === null) continue;
    const existing = byReason.get(bucket) ?? { units: 0, value: 0 };
    existing.units += Math.abs(m.quantityDelta);
    existing.value += m.costPrice === null ? 0 : Math.abs(m.quantityDelta) * m.costPrice;
    byReason.set(bucket, existing);
  }
  return byReason;
}

export type ShrinkageRow = { reason: string; units: number; value: number };

type StockMovementReasonRawRow = {
  product_id: string;
  quantity_delta: number;
  reason: string;
  created_at: string;
};

async function fetchShrinkageMovements(from: Date, to: Date): Promise<Result<ShrinkageMovement[]>> {
  const { data: invData, error: invError } = await db
    .from('inventory')
    .select('product_id, cost_price');
  if (invError) {
    logger.error('reports.shrinkage.fetch_failed', { message: invError.message });
    return err(unknownError(invError));
  }

  // Root cause of WINDOWS #27's PostgREST row-cap class: this query used to
  // fetch EVERY stock_movements row in range (sale/refund/delivery/etc.)
  // just to discard everything but loss reasons client-side in
  // groupShrinkageByReason — the wasted sale-reason rows were what pushed a
  // busy day past PGRST_DB_MAX_ROWS. Filtering to loss-only rows at the
  // query level removes that waste; loss events are inherently far rarer
  // than sales, so this is bounded in realistic operation. Values/bucketing
  // logic in groupShrinkageByReason is unchanged and untouched.
  const { data: movData, error: movError } = await db
    .from('stock_movements')
    .select('product_id, quantity_delta, reason, created_at')
    .lt('quantity_delta', 0)
    .in('reason', [...LOSS_REASONS, UNCLASSIFIED_REASON])
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString());
  if (movError) {
    logger.error('reports.shrinkage.fetch_failed', { message: movError.message });
    return err(unknownError(movError));
  }

  const costByProduct = new Map<string, number | null>(
    (invData as { product_id: string; cost_price: number | null }[]).map(r => [
      r.product_id,
      r.cost_price,
    ])
  );

  const movements: ShrinkageMovement[] = (movData as StockMovementReasonRawRow[]).map(r => ({
    productId: r.product_id,
    quantityDelta: r.quantity_delta,
    reason: r.reason,
    costPrice: costByProduct.get(r.product_id) ?? null,
    createdAt: new Date(r.created_at),
  }));

  return ok(movements);
}

function bucketsToRows(map: Map<string, ShrinkageBucket>): ShrinkageRow[] {
  return Array.from(map.entries()).map(([reason, v]) => ({ reason, ...v }));
}

/**
 * Shrinkage/Waste report (INVR-02): waste, correction, and unclassified
 * (pre-feature manual_adjustment) buckets — 'expired' is filtered out here
 * so its loss value is never double-counted against Expiry-Loss (INVR-03).
 * Independent query from useExpiryLossReport per this codebase's convention
 * of one fetch per report hook (see useCategoryRevenueReport vs.
 * useProductSalesReport) — no shared cache entry forced between them.
 */
export function useShrinkageWasteReport(from: Date, to: Date) {
  return useQuery({
    queryKey: ['reports', 'shrinkage-waste', from.toISOString(), to.toISOString()] as const,
    queryFn: async (): Promise<Result<ShrinkageRow[]>> => {
      const result = await fetchShrinkageMovements(from, to);
      if (!result.ok) return result;
      const grouped = groupShrinkageByReason(result.data);
      grouped.delete('expired');
      return ok(bucketsToRows(grouped));
    },
    staleTime: 60_000,
  });
}

/**
 * Expiry-Loss report (INVR-03): the same underlying stock_movements data as
 * Shrinkage/Waste, filtered to ONLY the 'expired' bucket (or an empty array
 * if no expired movements exist in range).
 */
export function useExpiryLossReport(from: Date, to: Date) {
  return useQuery({
    queryKey: ['reports', 'expiry-loss', from.toISOString(), to.toISOString()] as const,
    queryFn: async (): Promise<Result<ShrinkageRow[]>> => {
      const result = await fetchShrinkageMovements(from, to);
      if (!result.ok) return result;
      const grouped = groupShrinkageByReason(result.data);
      const expired = grouped.get('expired');
      return ok(expired ? [{ reason: 'expired', ...expired }] : []);
    },
    staleTime: 60_000,
  });
}

// ============================================================================
// PATTERN 3 (D-04): TURNOVER / SELL-THROUGH (INVR-04) — combines
// useProductSalesReport (units sold, reused verbatim from entities/tab) with
// a two-point average of computeInventoryValueAsOf (from 14-01), never a
// fabricated period-accurate historical valuation (Pitfall 3).
// ============================================================================

export type TurnoverValuationPoint = { productId: string; value: number | null };

export type TurnoverSalesInput = {
  productId: string;
  productName: string;
  categoryName: string;
  units: number;
};

export type TurnoverRow = {
  productId: string;
  productName: string;
  categoryName: string;
  unitsSold: number | null;
  avgValue: number | null;
  turnoverRatio: number | null;
};

/**
 * Combines units-sold rows (from useProductSalesReport, reused verbatim —
 * not re-implemented here) with the from/to two-point average of
 * computeInventoryValueAsOf into one per-product Turnover row. Unions every
 * productId across all three inputs so a product present in only one side
 * still renders a row with the missing side as `null` (never dropped, never
 * silently defaulted to 0). Division-by-zero guarded: avgValue===0 or null,
 * or unitsSold===null, yields turnoverRatio=null (never 0/Infinity/NaN).
 * Pure function — safe to call repeatedly with the same input (idempotent).
 */
export function combineTurnoverRows(
  salesRows: TurnoverSalesInput[],
  valueAtFrom: TurnoverValuationPoint[],
  valueAtTo: TurnoverValuationPoint[]
): TurnoverRow[] {
  const salesByProduct = new Map(salesRows.map(r => [r.productId, r]));
  const fromByProduct = new Map(valueAtFrom.map(r => [r.productId, r.value]));
  const toByProduct = new Map(valueAtTo.map(r => [r.productId, r.value]));

  const allProductIds = new Set<string>([
    ...salesByProduct.keys(),
    ...fromByProduct.keys(),
    ...toByProduct.keys(),
  ]);

  const rows: TurnoverRow[] = [];
  for (const productId of allProductIds) {
    const sales = salesByProduct.get(productId);
    const valueFrom = fromByProduct.has(productId) ? (fromByProduct.get(productId) ?? null) : null;
    const valueTo = toByProduct.has(productId) ? (toByProduct.get(productId) ?? null) : null;

    const avgValue =
      valueFrom === null || valueTo === null
        ? null
        : Math.round(((valueFrom + valueTo) / 2) * 100) / 100;

    const unitsSold = sales ? sales.units : null;

    const turnoverRatio =
      avgValue === null || avgValue === 0 || unitsSold === null
        ? null
        : Math.round((unitsSold / avgValue) * 100) / 100;

    rows.push({
      productId,
      productName: sales?.productName ?? i18n.t('entities:reports.unknownProduct'),
      categoryName: sales?.categoryName ?? i18n.t('entities:reports.uncategorized'),
      unitsSold,
      avgValue,
      turnoverRatio,
    });
  }
  return rows;
}

type TurnoverInventoryRawRow = {
  product_id: string;
  quantity_on_hand: number;
  cost_price: number | null;
};

/**
 * Turnover report (INVR-04) valuation side: fetches current stock, then
 * calls fetchDeltaMovementsTwoCutoffs (D-27 follow-up — bounded, server-side
 * summed deltas for BOTH cutoffs in one RPC call) and feeds each into
 * computeInventoryValueAsOf (D-04, shared with Valuation). This used to
 * share a single unbounded raw-movements fetch between both cutoffs (movements
 * after `from` is a superset of movements after `to`) — that fetch is what
 * WINDOWS #27's final review reproduced breaking once filler stock_movements
 * rows pushed it past PostgREST's row cap. One bounded two-cutoff RPC call
 * replaces the one unbounded fetch — same single-round-trip shape as before,
 * no longer subject to any row-count cap regardless of data volume. Units-sold
 * is intentionally NOT fetched here — TurnoverSection composes this hook's
 * result with useProductSalesReport directly (reused verbatim), avoiding a
 * hook-call-inside-queryFn antipattern.
 */
export function useTurnoverReport(from: Date, to: Date) {
  return useQuery({
    queryKey: ['reports', 'turnover-valuation', from.toISOString(), to.toISOString()] as const,
    queryFn: async (): Promise<
      Result<{ valueAtFrom: TurnoverValuationPoint[]; valueAtTo: TurnoverValuationPoint[] }>
    > => {
      const { data: invData, error: invError } = await db
        .from('inventory')
        .select('product_id, quantity_on_hand, cost_price');

      if (invError) {
        logger.error('reports.turnover.fetch_failed', { message: invError.message });
        return err(unknownError(invError));
      }

      const movResult = await fetchDeltaMovementsTwoCutoffs(from, to);
      if (!movResult.ok) return movResult;

      const invRows: TurnoverInventoryRawRow[] = Array.isArray(invData) ? invData : [];

      const current: CurrentStock[] = invRows.map(r => ({
        productId: r.product_id,
        quantityOnHand: r.quantity_on_hand,
        costPrice: r.cost_price,
      }));

      const atFrom = computeInventoryValueAsOf(current, movResult.data.atFrom, from);
      const atTo = computeInventoryValueAsOf(current, movResult.data.atTo, to);

      return ok({
        valueAtFrom: atFrom.map(r => ({ productId: r.productId, value: r.value })),
        valueAtTo: atTo.map(r => ({ productId: r.productId, value: r.value })),
      });
    },
    staleTime: 60_000,
  });
}
