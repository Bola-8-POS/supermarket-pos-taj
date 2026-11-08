/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, i18next/no-literal-string */
// i18next/no-literal-string: query-key namespace strings + multi-line Supabase
// chain args below are wire-protocol identifiers, not UI copy (plugin doesn't
// resolve excluded callees across a multi-line method chain — 21-08 quirk).
/**
 * entities/payment/model/queries.ts
 *
 * TanStack Query hooks for payment-related data fetching.
 * Uses `const db = supabase as any` pre-regen cast — payments/order_items join
 * not yet in supabase.types.ts until Phase 6 types are transcribed.
 */
import { useQuery } from '@tanstack/react-query';

import { ReceiptDataSchema, type ReceiptData } from '@shared/lib/edge-function-contracts';
import { supabase } from '@shared/lib/supabase';
// decomposeTax has zero imports of its own, so it's importable directly from
// src/ despite living under supabase/functions/ — same pattern already used
// by src/shared/lib/__tests__/edge-tax.test.ts (CR-01).
import { decomposeTax } from '../../../../supabase/functions/_shared/tax.ts';
import { PaymentSchema } from './types';
import type { Payment } from './types';

const db = supabase as any;

export const paymentKeys = {
  all: ['payments'] as const,
  lists: () => [...paymentKeys.all, 'list'] as const,
};

export const paymentReceiptKeys = {
  byTab: (tabId: string) => ['payment', 'receipt-data', tabId] as const,
};

/** Rounds to 2 decimal places — matches buildSaleReceipt()'s money-rounding convention. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const paymentItemKeys = {
  byPayment: (paymentId: string) => ['payment', 'order-items', paymentId] as const,
};

function mapPaymentRow(row: Record<string, unknown>): Payment {
  return PaymentSchema.parse({
    id: row['id'],
    tabId: row['tab_id'],
    amount: row['amount'],
    method: row['method'],
    squarePaymentId: row['square_payment_id'],
    squareReceiptUrl: row['square_receipt_url'],
    tenderedAmount: row['tendered_amount'],
    referenceNumber: row['reference_number'],
    idempotencyKey: row['idempotency_key'],
    processedAt: new Date(row['processed_at'] as string),
    processedBy: row['processed_by'],
    isRefund: row['is_refund'] ?? false,
    refundId: row['refund_id'] ?? null,
    status: row['status'] ?? 'completed',
  });
}

/** Fetch all recent payments (newest first, limit 100). */
export function usePayments() {
  return useQuery({
    queryKey: paymentKeys.lists(),
    queryFn: async (): Promise<Payment[]> => {
      const { data, error } = await db
        .from('payments')
        .select('*')
        .order('processed_at', { ascending: false })
        .limit(100);
      if (error) throw error as Error;
      return ((data ?? []) as Record<string, unknown>[]).map(mapPaymentRow);
    },
  });
}

type ReceiptOrderRow = {
  status: string;
  order_items:
    | {
        quantity: number;
        unit_price: number;
        modifier_price_delta: number;
        weight_grams: number | null;
        promotion_id: string | null;
        discount_rate: number | null;
        discount_amount: number | null;
        products: {
          name: string;
          category_id: string | null;
          categories: { name: string } | null;
        } | null;
      }[]
    | null;
};

type ReceiptPaymentRow = {
  amount: number;
  method: 'cash' | 'card';
  processed_at: string;
  tendered_amount: number | null;
  reference_number: string | null;
  discount_scope: 'all' | null;
  discount_type: 'percent' | 'fixed' | null;
  discount_value: number | null;
  discount_amount: number | null;
  status: string;
  is_refund: boolean;
  tax_rate_percent: number | null;
  tax_inclusive: boolean | null;
};

/**
 * Reconstructs ONE sale-level ReceiptData for a tab, read-only, from durable
 * rows alone (RESEARCH.md Pitfall 1: ReceiptData is never persisted — it
 * only ever existed transiently in the original payment response). Mirrors
 * `buildSaleReceipt()` in supabase/functions/process-direct-sale/index.ts
 * field-for-field, but with no staff/shift/caja filter — a reprint reads an
 * already-completed, RLS-visible sale, not re-authorizing a live payment.
 *
 * Groups every `payments` row sharing `tabId` into one `tenders[]` array
 * (Pitfall 4 / CR-03) — never builds ReceiptData from a single leg.
 */
export async function fetchReceiptDataForPayment(tabId: string): Promise<ReceiptData> {
  const [
    { data: tab },
    { data: payments },
    { data: orders },
    { data: settingsRow },
    { data: billingRow },
  ] = await Promise.all([
    db.from('tabs').select('customer_name, staff_id').eq('id', tabId).maybeSingle(),
    db
      .from('payments')
      .select(
        'amount, method, processed_at, tendered_amount, reference_number, discount_scope, discount_type, discount_value, discount_amount, status, is_refund, tax_rate_percent, tax_inclusive'
      )
      .eq('tab_id', tabId)
      .order('processed_at', { ascending: true }),
    db
      .from('orders')
      .select(
        'status, order_items(quantity, unit_price, modifier_price_delta, weight_grams, promotion_id, discount_rate, discount_amount, products(name, category_id, categories(name)))'
      )
      .eq('tab_id', tabId),
    db.from('settings').select('value').eq('key', 'general').maybeSingle(),
    db.from('settings').select('value').eq('key', 'billing').maybeSingle(),
  ]);

  if (!tab || !payments || (payments as unknown[]).length === 0 || !orders) {
    throw new Error(`fetchReceiptDataForPayment: sale not found for tab ${tabId}`);
  }

  const { data: cashier } = await db
    .from('profiles')
    .select('name')
    .eq('id', (tab as { staff_id: string }).staff_id)
    .maybeSingle();

  const items = (orders as ReceiptOrderRow[])
    .filter(order => order.status !== 'voided')
    .flatMap(order => order.order_items ?? [])
    .map(item => ({
      name: item.products?.name ?? 'Item',
      quantity: item.quantity,
      unitPrice: round2(item.unit_price + item.modifier_price_delta),
      lineTotal: round2((item.unit_price + item.modifier_price_delta) * item.quantity),
      categoryId: item.products?.category_id ?? null,
      categoryName: item.products?.categories?.name ?? null,
      modifierNames: [] as string[],
      weightGrams: item.weight_grams ?? null,
      promotionId: item.promotion_id ?? null,
      discountRate: item.discount_rate,
      discountAmount: item.discount_amount,
    }));

  const legs = payments as ReceiptPaymentRow[];
  const tenders = legs.map(leg => {
    const amount = leg.amount;
    const tenderedAmount = leg.tendered_amount;
    return {
      method: leg.method,
      amount,
      tenderedAmount,
      changeAmount: tenderedAmount == null ? null : round2(tenderedAmount - amount),
      terminalReference: leg.reference_number ?? undefined,
    };
  });

  const chargedAmount = round2(legs.reduce((sum, leg) => sum + leg.amount, 0));
  const firstLeg = legs[0];
  if (!firstLeg) {
    throw new Error(`fetchReceiptDataForPayment: no payment legs for tab ${tabId}`);
  }
  const soleTender = legs.length === 1 ? tenders[0] : undefined;
  const discountLeg = legs.find(leg => leg.discount_amount != null);

  const general = settingsRow?.value as { storeName?: string; address?: string } | null;
  // Prefer the rate/inclusive flag snapshotted on the sale's own payment legs
  // (the rate that applied when the charge was made) over today's setting —
  // a reprint after the billing rate changes must still match the original
  // print to the cent. Only completed, non-refund legs count; the stored
  // tax_amount itself is not summed here (it exists for reports), the
  // charged total is redecomposed with the stored rate instead, so rounding
  // matches the original print regardless of per-leg rounding.
  const taxLegs = legs.filter(leg => leg.status === 'completed' && !leg.is_refund);
  const storedTaxLeg =
    taxLegs.length > 0 && taxLegs.every(leg => leg.tax_rate_percent != null && leg.tax_inclusive != null)
      ? taxLegs[0]
      : undefined;
  const billing = billingRow?.value as { taxRatePercent?: number; taxInclusive?: boolean } | null;
  const taxRatePercent = storedTaxLeg ? (storedTaxLeg.tax_rate_percent as number) : billing?.taxRatePercent ?? 16;
  const taxInclusive = storedTaxLeg ? (storedTaxLeg.tax_inclusive as boolean) : billing?.taxInclusive ?? true;
  const { subtotal, taxAmount, total } = decomposeTax(chargedAmount, taxRatePercent, taxInclusive);

  return ReceiptDataSchema.parse({
    receiptNumber: tabId.slice(0, 8).toUpperCase(),
    tabId,
    customerName: (tab as { customer_name: string | null }).customer_name ?? 'Walk-in',
    items,
    subtotal,
    total,
    taxAmount,
    taxRatePercent,
    taxInclusive,
    paymentMethod: firstLeg.method,
    processedAt: firstLeg.processed_at,
    squareReceiptUrl: null,
    cashierName: (cashier as { name?: string } | null)?.name ?? 'Staff',
    storeName: general?.storeName ?? 'Supermarket POS',
    barAddress: general?.address ?? '',
    tenderedAmount: soleTender?.tenderedAmount ?? null,
    changeAmount: soleTender?.changeAmount ?? null,
    terminalReference: soleTender?.terminalReference,
    discountAmount: discountLeg?.discount_amount == null ? undefined : discountLeg.discount_amount,
    discountScope: discountLeg?.discount_scope ?? undefined,
    discountType: discountLeg?.discount_type ?? undefined,
    discountValue: discountLeg?.discount_value == null ? undefined : discountLeg.discount_value,
    tenders,
  });
}

/** Reprint read for a completed sale, keyed by tabId — every leg grouped into one receipt. */
export function useReceiptDataForPayment(tabId: string | null) {
  return useQuery({
    queryKey: tabId
      ? paymentReceiptKeys.byTab(tabId)
      : (['payment', 'receipt-data', null] as const),
    enabled: tabId !== null,
    queryFn: () => fetchReceiptDataForPayment(tabId as string),
  });
}

export interface OrderItemForRefund {
  id: string;
  qty: number;
  unit_price: number;
  parent_order_item_id: string | null;
  products: { name: string };
}

/**
 * Fetch order_items for the tab associated with a payment.
 * Uses three sequential queries: payment → orders → order_items.
 */
export function useOrderItemsByPayment(paymentId: string | null) {
  return useQuery({
    queryKey: paymentId
      ? paymentItemKeys.byPayment(paymentId)
      : (['payment', 'order-items', null] as const),
    enabled: paymentId != null,
    queryFn: async (): Promise<OrderItemForRefund[]> => {
      if (paymentId == null) return []; // guard: enabled only when paymentId != null

      // Step 1: resolve the tab_id from the payment
      const { data: paymentRow, error: payErr } = await db
        .from('payments')
        .select('tab_id')
        .eq('id', paymentId)
        .single();
      if (payErr) throw payErr as Error;

      const tabId = (paymentRow as { tab_id: string }).tab_id;

      // Step 2: resolve order IDs for that tab
      const { data: orders, error: orderErr } = await db
        .from('orders')
        .select('id')
        .eq('tab_id', tabId);
      if (orderErr) throw orderErr as Error;

      const orderIds = ((orders ?? []) as Array<{ id: string }>).map(o => o.id);
      if (orderIds.length === 0) return [];

      // Step 3: fetch top-level order_items (no parent) for those orders
      // NOTE: the order_items table column is `quantity`, not `qty` — mapped to the
      // `qty` field on OrderItemForRefund below to keep the existing external contract.
      const { data: items, error: itemErr } = await db
        .from('order_items')
        .select('id, quantity, unit_price, parent_order_item_id, products!inner(name)')
        .in('order_id', orderIds)
        .is('parent_order_item_id', null);
      if (itemErr) throw itemErr as Error;

      return ((items ?? []) as Array<Record<string, unknown>>).map(
        (row): OrderItemForRefund => ({
          id: row['id'] as string,
          qty: row['quantity'] as number,
          unit_price: row['unit_price'] as number,
          parent_order_item_id: row['parent_order_item_id'] as string | null,
          products: row['products'] as { name: string },
        })
      );
    },
  });
}
