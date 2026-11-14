/**
 * Sales tab + Transactions sub-screen queries. Every fetch: Supabase query/RPC → throw on
 * error → Zod parse. Pure aggregation helpers are exported separately so they're unit-testable.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { methodLabel } from '@/lib/format';
import {
  CategoryRevenueRowSchema,
  HourlyRowSchema,
  OrderItemSchema,
  PaymentMethodRowSchema,
  PaymentSchema,
  RefundSchema,
  ReportEnvelope,
  TabSchema,
  type CategoryRevenueRow,
  type HourlyRow,
  type PaymentMethodRow,
  type ProductSalesRow,
} from '@/lib/schemas';
import { ProductSalesRowSchema } from '@/lib/schemas';
import { supabase } from '@/lib/supabase';

export { summarize as summarizeRange } from '@/features/today/queries';

export type DateRange = { from: Date; to: Date };
export type BarDatum = { label: string; value: number };

// ---- Report RPCs ----

async function fetchReport<T>(rpc: string, range: DateRange, rowSchema: z.ZodType<T>): Promise<T[]> {
  // supabase.rpc()'s overloads are keyed off generated Database types this client doesn't
  // carry (see CLAUDE.md's "Missing generated types workaround"); the result is typed `any`
  // for a dynamic rpc name, so pin it to an explicit shape instead of destructuring `any`.
  const { data, error } = (await supabase.rpc(rpc, {
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
  })) as { data: unknown; error: { message: string } | null };
  if (error) throw new Error(error.message);
  const parsed = ReportEnvelope(rowSchema).parse(data);
  if (!parsed.ok) throw new Error(`${rpc} returned ok:false`);
  return parsed.rows ?? [];
}

const rangeKey = (range: DateRange) => [range.from.toISOString(), range.to.toISOString()];

export function usePaymentMethodsReport(range: DateRange) {
  return useQuery({
    queryKey: ['sales', 'payment-methods', ...rangeKey(range)],
    queryFn: () => fetchReport('get_payment_methods_report', range, PaymentMethodRowSchema),
  });
}

export function usePeakHoursReport(range: DateRange) {
  return useQuery({
    queryKey: ['sales', 'peak-hours', ...rangeKey(range)],
    queryFn: () => fetchReport('get_peak_hours_report', range, HourlyRowSchema),
  });
}

export function useProductSalesReport(range: DateRange) {
  return useQuery({
    queryKey: ['sales', 'product-sales', ...rangeKey(range)],
    queryFn: () => fetchReport('get_product_sales_report', range, ProductSalesRowSchema),
  });
}

export function useCategoryRevenueReport(range: DateRange) {
  return useQuery({
    queryKey: ['sales', 'category-revenue', ...rangeKey(range)],
    queryFn: () => fetchReport('get_category_revenue_report', range, CategoryRevenueRowSchema),
  });
}

/** Range-scoped payments, for the summary KPIs (mirrors today/queries' useTodayPayments). */
export function useSalesPayments(range: DateRange) {
  return useQuery({
    queryKey: ['sales', 'payments', ...rangeKey(range)],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payments')
        .select('id,tab_id,amount,method,status,is_refund,processed_at,processed_by,reference_number,discount_amount')
        .eq('is_deleted', false)
        .gte('processed_at', range.from.toISOString())
        .lte('processed_at', range.to.toISOString())
        .order('processed_at', { ascending: false });
      if (error) throw new Error(error.message);
      return z.array(PaymentSchema).parse(data);
    },
  });
}

// ---- Pure helpers (unit-testable) ----

/** Sum payment-method rollup rows into chart bars, falling back to summing non-rollup rows. */
export function aggregatePaymentMethods(rows: PaymentMethodRow[]): BarDatum[] {
  const rollups = rows.filter(r => r.isRollup);
  const source = rollups.length > 0 ? rollups : rows.filter(r => !r.isRollup);
  const byMethod = new Map<string, number>();
  for (const r of source) {
    byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + r.grossAmount);
  }
  return [...byMethod.entries()]
    .map(([method, value]) => ({ label: methodLabel[method] ?? method, value }))
    .sort((a, b) => b.value - a.value);
}

/** Fill all 24 hours (summing revenue across day-of-week buckets), zero where missing. */
export function fillHours(rows: HourlyRow[]): BarDatum[] {
  const revenueByHour = new Array<number>(24).fill(0);
  for (const r of rows) {
    if (r.hour >= 0 && r.hour < 24) revenueByHour[r.hour] = (revenueByHour[r.hour] ?? 0) + r.revenue;
  }
  return revenueByHour.map((value, hour) => ({ label: String(hour), value }));
}

/** Index of the busiest hour, or undefined if there's no sales at all. */
export function busiestHourIndex(hours: BarDatum[]): number | undefined {
  let best = -1;
  let bestValue = 0;
  hours.forEach((h, i) => {
    if (h.value > bestValue) {
      bestValue = h.value;
      best = i;
    }
  });
  return best === -1 ? undefined : best;
}

/** Top N rows by revenue, descending. */
export function topN<T extends { revenue: number }>(rows: T[], n = 10): T[] {
  return [...rows].sort((a, b) => b.revenue - a.revenue).slice(0, n);
}

export function categoryBars(rows: CategoryRevenueRow[]): BarDatum[] {
  return [...rows].sort((a, b) => b.revenue - a.revenue).map(r => ({ label: r.categoryName ?? 'Uncategorized', value: r.revenue }));
}

export function productMarginPct(row: ProductSalesRow): number | null {
  return row.marginPct;
}

// ---- Transactions list (paginated) ----

const PAGE_SIZE = 30;

const TransactionRowSchema = TabSchema.extend({
  payments: z.array(z.object({ amount: z.number(), method: z.string(), is_refund: z.boolean(), status: z.string() })),
});
export type TransactionRow = z.infer<typeof TransactionRowSchema> & { total: number; methods: string[] };

function withTotals(t: z.infer<typeof TransactionRowSchema>): TransactionRow {
  // Mirrors today/queries.ts' summarize(): only 'completed' payments are settled money
  // (excludes pending/disputed bank transfers and reopened/voided sales).
  const paid = t.payments.filter(p => !p.is_refund && p.status === 'completed');
  return { ...t, total: paid.reduce((s, p) => s + p.amount, 0), methods: [...new Set(paid.map(p => p.method))] };
}

/** Paginated paid tabs, optionally filtered by customer name or ticket-id prefix. */
export function useTransactions(search: string) {
  const q = search.trim();
  return useInfiniteQuery({
    queryKey: ['transactions', 'list', q],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      let query = supabase
        .from('tabs')
        .select(
          'id,status,staff_id,customer_name,opened_at,closed_at,caja_session_id,notes, payments(amount,method,is_refund,status)',
        )
        .in('status', ['closed', 'paid'])
        .eq('is_deleted', false);
      if (q) {
        // ponytail: id is uuid — PostgREST's `column::cast` filter syntax lets ilike run against
        // its text form so a partial ticket id still matches.
        query = query.or(`customer_name.ilike.%${q}%,id::text.ilike.${q}%`);
      }
      const { data, error } = await query.order('closed_at', { ascending: false }).range(pageParam, pageParam + PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      return z.array(TransactionRowSchema).parse(data).map(withTotals);
    },
    getNextPageParam: (lastPage, allPages) => (lastPage.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined),
  });
}

// ---- Transaction detail ----

const OrderWithItemsSchema = z.object({ id: z.string(), order_items: z.array(OrderItemSchema) });
const PaymentWithRefundsSchema = PaymentSchema.extend({ refunds: z.array(RefundSchema) });

export function useTransactionDetail(id: string) {
  return useQuery({
    queryKey: ['transactions', 'detail', id],
    enabled: !!id,
    queryFn: async () => {
      const [tabRes, ordersRes, paymentsRes] = await Promise.all([
        supabase
          .from('tabs')
          .select('id,status,staff_id,customer_name,opened_at,closed_at,caja_session_id,notes')
          .eq('id', id)
          .single(),
        supabase
          .from('orders')
          .select('id, order_items(id,product_id,quantity,unit_price,discount_amount,weight_grams,is_deleted, products(name))')
          .eq('tab_id', id),
        supabase
          .from('payments')
          .select(
            'id,tab_id,amount,method,status,is_refund,processed_at,processed_by,reference_number,discount_amount, refunds!original_payment_id(id,amount,reason,created_at,created_by,original_payment_id)',
          )
          .eq('tab_id', id)
          .eq('is_deleted', false)
          .order('processed_at', { ascending: true }),
      ]);
      if (tabRes.error) throw new Error(tabRes.error.message);
      if (ordersRes.error) throw new Error(ordersRes.error.message);
      if (paymentsRes.error) throw new Error(paymentsRes.error.message);

      const tab = TabSchema.parse(tabRes.data);
      const orders = z.array(OrderWithItemsSchema).parse(ordersRes.data);
      const orderItems = orders.flatMap(o => o.order_items).filter(i => !i.is_deleted);
      const payments = z.array(PaymentWithRefundsSchema).parse(paymentsRes.data);
      const refunds = payments.flatMap(p => p.refunds);

      return { tab, orderItems, payments, refunds };
    },
  });
}
