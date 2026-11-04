/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Report-specific queries for the tab entity.
 * Kept in a sibling file to queries.ts to avoid bloating the main queries file.
 */

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type {
  HourlyRow,
  ProductSalesRow,
  VoidRefundRow,
  CategoryRevenueRow,
  RefundRegisterRow,
  DeletionsPreRow,
  DeletionsPostRow,
  PaymentMethodRow,
} from '@shared/lib/domain';
import {
  HourlyRowSchema,
  VoidRefundRowSchema,
  DeletionsPreRowSchema,
  DeletionsPostRowSchema,
  PaymentMethodRowSchema,
} from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, unknownError, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
/* eslint-disable i18next/no-literal-string -- internal map-grouping-key
   fallbacks ('unknown') + query-key namespace strings + multi-line Supabase
   chain args below are wire-protocol identifiers, not UI copy (plugin
   doesn't resolve excluded callees across a multi-line method chain — 21-08
   quirk); genuine user-facing report fallback labels ('Uncategorized' etc.)
   are translated via i18n.t() below regardless of this disable. */

export type {
  HourlyRow,
  ProductSalesRow,
  VoidRefundRow,
  CategoryRevenueRow,
  RefundRegisterRow,
  DeletionsPreRow,
  DeletionsPostRow,
  PaymentMethodRow,
};

// Intermediate type used during aggregation before pctTotal is computed
type CategoryRevenueAggregate = Omit<CategoryRevenueRow, 'pctTotal'>;

// Raw get_product_sales_report row shape, validated at runtime like
// RawHourlyRowSchema below — an RPC row is external data (CLAUDE.md: "Zod
// for all external data validation"), and a malformed/null units/revenue
// must fail loudly instead of flowing into computePctTotals as NaN.
const RawProductSalesRowSchema = z.object({
  productId: z.string(),
  productName: z.string().nullable(),
  categoryName: z.string().nullable(),
  units: z.number(),
  revenue: z.number(),
  costTotal: z.number().nullable(),
  margin: z.number().nullable(),
  marginPct: z.number().nullable(),
});

// Same rationale as RawProductSalesRowSchema above — validates
// get_category_revenue_report's RPC rows before use.
const RawCategoryRevenueRowSchema = z.object({
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  unitsSold: z.number(),
  orderCount: z.number(),
  revenue: z.number(),
});

const db = supabase as any;

// ============================================================================
// PURE HELPER FUNCTIONS (exported for unit tests)
// ============================================================================

/**
 * Computes the percentage of total revenue for each row.
 * Returns an array of percentages (0–100) in the same order as the input rows.
 */
export function computePctTotals(rows: Array<{ revenue: number }>): number[] {
  const total = rows.reduce((sum, r) => sum + r.revenue, 0);
  if (total === 0) return rows.map(() => 0);
  return rows.map(r => Math.round((r.revenue / total) * 10000) / 100);
}

type HourlyItem = {
  orders: { created_at: string } | null;
  quantity: unknown;
  unit_price: unknown;
  modifier_price_delta: unknown;
};

/**
 * Aggregates raw order_item rows into per-hour totals.
 * Exported as a pure function so hourly bucketing can be unit-tested independently.
 */
export function aggregateHourlyRevenue(items: HourlyItem[]): HourlyRow[] {
  const map = new Map<number, { orderCount: number; revenue: number; dayOfWeek: number }>();

  for (const item of items) {
    const orderCreatedAt: string = item.orders?.created_at ?? '';
    if (!orderCreatedAt) continue;
    const createdDate = new Date(orderCreatedAt);
    const hour = createdDate.getHours();
    const dayOfWeek = createdDate.getDay();
    const quantity: number = typeof item.quantity === 'number' ? item.quantity : 0;
    const unitPrice: number = typeof item.unit_price === 'number' ? item.unit_price : 0;
    const modDelta: number =
      typeof item.modifier_price_delta === 'number' ? item.modifier_price_delta : 0;
    const lineRev = quantity * (unitPrice + modDelta);

    const existing = map.get(hour);
    if (existing) {
      existing.orderCount += 1;
      existing.revenue += lineRev;
      existing.dayOfWeek = dayOfWeek;
    } else {
      map.set(hour, { orderCount: 1, revenue: lineRev, dayOfWeek });
    }
  }

  // D-04: dayOfWeek/isBusiest are required on HourlyRow post-24-01. isBusiest
  // is always derived client-side by findPeakHour (see useHourlyBreakdown)
  // rather than computed here, so it defaults to false in this pure helper.
  return Array.from(map.entries()).map(([hour, v]) => ({
    hour,
    orderCount: v.orderCount,
    revenue: Math.round(v.revenue * 100) / 100,
    dayOfWeek: v.dayOfWeek,
    isBusiest: false,
  }));
}

/**
 * Fills in missing hours (0–23) with zero-revenue rows.
 * Returns a sorted 24-entry array.
 */
export function fillMissingHours(rows: HourlyRow[]): HourlyRow[] {
  const byHour = new Map<number, HourlyRow>();
  for (const r of rows) byHour.set(r.hour, r);

  const result: HourlyRow[] = [];
  for (let h = 0; h < 24; h++) {
    result.push(
      byHour.get(h) ?? { hour: h, orderCount: 0, revenue: 0, dayOfWeek: 0, isBusiest: false }
    );
  }
  return result;
}

/**
 * Returns the hour with the highest revenue, or null if all hours are zero.
 */
export function findPeakHour(rows: HourlyRow[]): HourlyRow | null {
  const nonZero = rows.filter(r => r.revenue > 0);
  if (nonZero.length === 0) return null;
  return nonZero.reduce((best, r) => (r.revenue > best.revenue ? r : best));
}

/**
 * Returns the hour with the lowest non-zero revenue, or null if all hours are zero.
 */
export function findSlowestHour(rows: HourlyRow[]): HourlyRow | null {
  const nonZero = rows.filter(r => r.revenue > 0);
  if (nonZero.length === 0) return null;
  return nonZero.reduce((slowest, r) => (r.revenue < slowest.revenue ? r : slowest));
}

/**
 * Fills missing categories (from allCategories list) with zero-revenue rows.
 * Returns rows sorted by revenue descending, with canonical categories always present.
 */
export function fillMissingCategories(
  rows: CategoryRevenueAggregate[],
  allCategories: Array<{ id: string; name: string }>
): CategoryRevenueAggregate[] {
  const existing = new Map(rows.map(r => [r.categoryId, r]));
  const result = allCategories.map(
    cat =>
      existing.get(cat.id) ?? {
        categoryId: cat.id,
        categoryName: cat.name,
        unitsSold: 0,
        orderCount: 0,
        revenue: 0,
      }
  );
  return result.sort((a, b) => b.revenue - a.revenue);
}

/**
 * Aggregates raw order_item rows into per-category totals.
 * Exported as a pure function so aggregation logic can be unit-tested independently.
 */
export function aggregateCategoryRevenue(
  items: Array<{
    quantity: unknown;
    unit_price: unknown;
    modifier_price_delta: unknown;
    products: { categories: { id: string; name: string } | null } | null;
  }>
): CategoryRevenueAggregate[] {
  const map = new Map<
    string,
    { categoryName: string; unitsSold: number; orderCount: number; revenue: number }
  >();

  for (const item of items) {
    const categoryId: string = item.products?.categories?.id ?? 'unknown';
    const categoryName: string =
      item.products?.categories?.name ?? i18n.t('entities:reports.uncategorized');
    const quantity: number = typeof item.quantity === 'number' ? item.quantity : 0;
    const unitPrice: number = typeof item.unit_price === 'number' ? item.unit_price : 0;
    const modDelta: number =
      typeof item.modifier_price_delta === 'number' ? item.modifier_price_delta : 0;
    const lineRev = quantity * (unitPrice + modDelta);

    const existing = map.get(categoryId);
    if (existing) {
      existing.unitsSold += quantity;
      existing.orderCount += 1;
      existing.revenue += lineRev;
    } else {
      map.set(categoryId, { categoryName, unitsSold: quantity, orderCount: 1, revenue: lineRev });
    }
  }

  return Array.from(map.entries()).map(([categoryId, v]) => ({
    categoryId,
    categoryName: v.categoryName,
    unitsSold: v.unitsSold,
    orderCount: v.orderCount,
    revenue: Math.round(v.revenue * 100) / 100,
  }));
}

// ============================================================================
// PRODUCT SALES REPORT
// ============================================================================

/**
 * Fetches product sales data for the given date range.
 * Groups by product and computes units sold, revenue, and % of total.
 */
export function useProductSalesReport(from: Date, to: Date) {
  return useQuery({
    queryKey: ['reports', 'product-sales', from.toISOString(), to.toISOString()] as const,
    queryFn: async (): Promise<Result<ProductSalesRow[]>> => {
      // Server-side bounded aggregation (D-27 fix) — replaces the prior
      // unbounded order_items join, which silently truncated at
      // PostgREST's PGRST_DB_MAX_ROWS once a day's order_items exceeded it.
      const { data, error } = await db.rpc('get_product_sales_report', {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });

      if (error) {
        logger.error('reports.product_sales.fetch_failed', { message: error.message });
        return err(unknownError(error));
      }

      const parsed = data as { ok: boolean; rows?: unknown[] } | null;
      if (!parsed?.ok) {
        return err(unknownError('get_product_sales_report returned ok:false'));
      }

      try {
        const rows: Array<Omit<ProductSalesRow, 'pctTotal'>> = (parsed.rows ?? []).map(raw => {
          const row = RawProductSalesRowSchema.parse(raw);
          return {
            productId: row.productId,
            productName: row.productName ?? i18n.t('entities:reports.unknownProduct'),
            categoryName: row.categoryName ?? i18n.t('entities:reports.uncategorized'),
            units: row.units,
            revenue: row.revenue,
            costTotal: row.costTotal,
            margin: row.margin,
            marginPct: row.marginPct,
          };
        });

        const pcts = computePctTotals(rows);
        const result: ProductSalesRow[] = rows.map((r, i) => ({ ...r, pctTotal: pcts[i] ?? 0 }));
        return ok(result);
      } catch (e) {
        return err(unknownError(e));
      }
    },
    staleTime: 60_000,
  });
}

// ============================================================================
// HOURLY BREAKDOWN REPORT
// ============================================================================

// RPC row shape before the client-derived `isBusiest` flag is attached
// (get_peak_hours_report returns hour/dayOfWeek/orderCount/revenue only —
// "busiest" stays a client-side derivation via findPeakHour, D-03).
const RawHourlyRowSchema = HourlyRowSchema.omit({ isBusiest: true });

/**
 * Fetches peak-hours revenue breakdown for the given date range via the
 * bounded `get_peak_hours_report` RPC (D-01/D-03/SC-4 — replaces the prior
 * unbounded order_items join). Missing hours are filled with zeros and the
 * busiest hour is derived client-side, exactly as before the migration.
 */
export function useHourlyBreakdown(from: Date, to: Date) {
  return useQuery({
    queryKey: ['reports', 'hourly-breakdown', from.toISOString(), to.toISOString()] as const,
    queryFn: async (): Promise<Result<HourlyRow[]>> => {
      const { data, error } = await db.rpc('get_peak_hours_report', {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });

      if (error) {
        logger.error('reports.hourly_breakdown.fetch_failed', { message: error.message });
        return err(unknownError(error));
      }

      const parsed = data as { ok: boolean; rows?: unknown[] } | null;
      if (!parsed?.ok) {
        return err(unknownError('get_peak_hours_report returned ok:false'));
      }

      try {
        const raw = (parsed.rows ?? []).map(r => RawHourlyRowSchema.parse(r));
        const filled = fillMissingHours(raw.map(r => ({ ...r, isBusiest: false })));
        const peak = findPeakHour(filled);
        const rows: HourlyRow[] = filled.map(r => ({
          ...r,
          isBusiest: peak !== null && r.hour === peak.hour,
        }));
        return ok(rows);
      } catch (e) {
        return err(unknownError(e));
      }
    },
    staleTime: 60_000,
  });
}

// ============================================================================
// VOID / REFUND REPORT
// ============================================================================

/**
 * Filters void refund rows to those whose voidedAt falls within [from, to].
 * Exported for unit tests.
 */
export function filterVoidRefundRows(rows: VoidRefundRow[], from: Date, to: Date): VoidRefundRow[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return rows.filter(r => {
    const t = r.voidedAt.getTime();
    return t >= fromMs && t <= toMs;
  });
}

/**
 * Fetches all voided orders for the given date range via the bounded
 * `get_voids_report` RPC (D-01/D-02/SC-4 — replaces the prior unbounded
 * orders+order_items join). Row shape (orderId/voidedAt/staffName/amount/
 * reason) is unchanged so the voids-excel/voids-pdf exporters need no edits.
 */
export function useVoidRefundReport(from: Date, to: Date) {
  return useQuery({
    queryKey: ['reports', 'void-refund', from.toISOString(), to.toISOString()] as const,
    queryFn: async (): Promise<Result<VoidRefundRow[]>> => {
      const { data, error } = await db.rpc('get_voids_report', {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });

      if (error) {
        logger.error('reports.void_refund.fetch_failed', { message: error.message });
        return err(unknownError(error));
      }

      const parsed = data as { ok: boolean; rows?: unknown[] } | null;
      if (!parsed?.ok) {
        return err(unknownError('get_voids_report returned ok:false'));
      }

      try {
        return ok((parsed.rows ?? []).map(r => VoidRefundRowSchema.parse(r)));
      } catch (e) {
        return err(unknownError(e));
      }
    },
    staleTime: 60_000,
  });
}

// ============================================================================
// CATEGORY REVENUE REPORT
// ============================================================================

/**
 * Fetches category revenue data for the given date range.
 * Groups by category and computes units sold, order count, revenue, and % of total.
 * All categories from the DB are always present in the result (zero-revenue rows filled in).
 */
export function useCategoryRevenueReport(from: Date, to: Date) {
  return useQuery({
    queryKey: ['reports', 'category-revenue', from.toISOString(), to.toISOString()] as const,
    queryFn: async (): Promise<Result<CategoryRevenueRow[]>> => {
      // Fetch canonical category list so zero-revenue categories always appear
      const { data: cats, error: catsError } = await db
        .from('categories')
        .select('id, name')
        .order('name');

      if (catsError) {
        logger.error('reports.category_revenue.categories_fetch_failed', {
          message: catsError.message,
        });
        return err(unknownError(catsError));
      }

      const allCategories: Array<{ id: string; name: string }> = Array.isArray(cats) ? cats : [];

      // Server-side bounded aggregation (same fix as useProductSalesReport) —
      // replaces a prior unbounded order_items join that fetched every
      // product's line items for the date range and was subject to
      // PostgREST's PGRST_DB_MAX_ROWS truncation once a day's order_items
      // exceeded it.
      const { data, error } = await db.rpc('get_category_revenue_report', {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });

      if (error) {
        logger.error('reports.category_revenue.fetch_failed', { message: error.message });
        return err(unknownError(error));
      }

      const parsed = data as { ok: boolean; rows?: unknown[] } | null;
      if (!parsed?.ok) {
        return err(unknownError('get_category_revenue_report returned ok:false'));
      }

      let aggregated: CategoryRevenueAggregate[];
      try {
        aggregated = (parsed.rows ?? []).map(raw => {
          const row = RawCategoryRevenueRowSchema.parse(raw);
          return {
            categoryId: row.categoryId ?? 'unknown',
            categoryName: row.categoryName ?? i18n.t('entities:reports.uncategorized'),
            unitsSold: row.unitsSold,
            orderCount: row.orderCount,
            revenue: row.revenue,
          };
        });
      } catch (e) {
        return err(unknownError(e));
      }

      const filled = fillMissingCategories(aggregated, allCategories);
      const pcts = computePctTotals(filled);
      const result: CategoryRevenueRow[] = filled.map((r, i) => ({ ...r, pctTotal: pcts[i] ?? 0 }));
      return ok(result);
    },
    staleTime: 60_000,
  });
}

// ============================================================================
// Phase 8 S6-01/03-09: Date-range guard + new report hooks
// ============================================================================

export function assertDateRangeValid(from: Date, to: Date): void {
  const daysDiff = Math.abs((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff > 365) {
    throw new Error(i18n.t('entities:reports.dateRangeExceeded'));
  }
}

// ----------------------------------------------------------------------------
// Phase 8 S6-01/S6-06: RefundsRegister hook
// ----------------------------------------------------------------------------
export function useRefundsRegister(from: Date, to: Date) {
  return useQuery({
    queryKey: ['reports', 'refunds-register', from.toISOString(), to.toISOString()],
    queryFn: async (): Promise<Result<RefundRegisterRow[]>> => {
      assertDateRangeValid(from, to);
      const { data, error } = await db
        .from('refunds')
        .select(
          `
          id,
          created_at,
          original_payment_id,
          amount,
          reason,
          profiles!created_by ( name ),
          refund_items ( id, restock )
        `
        )
        .gte('created_at', from.toISOString())
        .lte('created_at', to.toISOString())
        .order('created_at', { ascending: false });
      if (error) return err(unknownError(error));
      return ok(
        (data as Array<Record<string, unknown>>).map(r => {
          const profile = r['profiles'] as Record<string, unknown> | null;
          const items = (r['refund_items'] as Array<{ id: string; restock: boolean }> | null) ?? [];
          return {
            id: r['id'] as string,
            date: new Date(r['created_at'] as string),
            operatorName: (profile?.['name'] as string | undefined) ?? '—',
            originalPaymentId: r['original_payment_id'] as string,
            amount: r['amount'] as number,
            reason: r['reason'] as RefundRegisterRow['reason'],
            restockCount: items.filter(i => i.restock).length,
            items: [] as RefundRegisterRow['items'],
          };
        })
      );
    },
  });
}

// ============================================================================
// Phase 24 Plan 06: deletions-pre / deletions-post / modifier-popularity /
// payment-methods report hooks — all follow the same bounded RPC shape
// ({ok, rows} → Zod-parse per row) as useVoidRefundReport above (Pattern 2).
// ============================================================================

/** Shared body for the 4 report RPCs below — fetch, unwrap {ok, rows}, Zod-parse. */
function useReportRpc<T>(
  reportName: string,
  rpcName: string,
  from: Date,
  to: Date,
  schema: { parse: (v: unknown) => T }
) {
  return useQuery({
    queryKey: ['reports', reportName, from.toISOString(), to.toISOString()] as const,
    queryFn: async (): Promise<Result<T[]>> => {
      const { data, error } = await db.rpc(rpcName, {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });

      if (error) {
        logger.error(`reports.${reportName}.fetch_failed`, { message: error.message });
        return err(unknownError(error));
      }

      const parsed = data as { ok: boolean; rows?: unknown[] } | null;
      if (!parsed?.ok) {
        return err(unknownError(`${rpcName} returned ok:false`));
      }

      try {
        return ok((parsed.rows ?? []).map(r => schema.parse(r)));
      } catch (e) {
        return err(unknownError(e));
      }
    },
    staleTime: 60_000,
  });
}

/** D-05 variant A: pre-send order-item removals (remove_tab_item audit rows). */
export function useDeletionsPreReport(from: Date, to: Date) {
  return useReportRpc('deletions-pre', 'get_deletions_pre_report', from, to, DeletionsPreRowSchema);
}

/** D-05 variant B: post-close corrections (edit_paid_tab audit rows). */
export function useDeletionsPostReport(from: Date, to: Date) {
  return useReportRpc(
    'deletions-post',
    'get_deletions_post_report',
    from,
    to,
    DeletionsPostRowSchema
  );
}

/** D-08: per-caja-session rows + one day-level rollup row per payment method. */
export function usePaymentMethodsReport(from: Date, to: Date) {
  return useReportRpc(
    'payment-methods',
    'get_payment_methods_report',
    from,
    to,
    PaymentMethodRowSchema
  );
}
