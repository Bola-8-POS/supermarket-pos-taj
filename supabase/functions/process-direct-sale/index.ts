import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts';

import { decomposeTax } from '../_shared/tax.ts';

const itemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(99),
  unitPrice: z.number().nonnegative().multipleOf(0.01),
  modifierIds: z.array(z.string().uuid()).default([]),
  modifierPriceDelta: z.number().nonnegative().multipleOf(0.01).default(0),
  weightGrams: z.number().int().positive().max(50000).optional(),
  notes: z.string().max(200).nullable().optional(),
});
const legSchema = z.object({
  method: z.enum(['cash', 'card', 'rappi', 'uber_eats']),
  amount: z.number().nonnegative().multipleOf(0.01),
  tenderedAmount: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  referenceNumber: z.string().max(64).nullable().optional(),
});
const BodySchema = z
  .object({
    items: z.array(itemSchema).min(1),
    shiftId: z.string().uuid(),
    cajaSessionId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(255),
    method: z.enum(['cash', 'card', 'bank_transfer', 'rappi', 'uber_eats']).optional(),
    amount: z.number().nonnegative().multipleOf(0.01).optional(),
    tenderedAmount: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
    referenceNumber: z.string().max(64).nullable().optional(),
    legs: z.array(legSchema).min(1).max(4).optional(),
    expectedTotal: z.number().nonnegative().multipleOf(0.01).optional(),
    // Phase 27 (PROMO-05): pool_only/consumptions_only scopes retired —
    // 'all' is the only member left, matching domain.ts's DiscountScopeSchema
    // and process_direct_sale_atomic's own INVALID_DISCOUNT_SCOPE check.
    discountScope: z.enum(['all']).optional(),
    discountType: z.enum(['percent', 'fixed']).optional(),
    discountValue: z.number().nonnegative().optional(),
    discountAmount: z.number().nonnegative().multipleOf(0.01).optional(),
    customerName: z.string().min(1).max(100).optional(),
    customerPhone: z.string().min(1).max(30).optional(),
    // Phase 27 (PROMO-05/07): manager-PIN authorization for the ad-hoc
    // discount and/or the below-cost floor-guard override.
    managerOverride: z.boolean().optional(),
    // Phase 27 Plan 08 (G-27-13): the entered PIN of the staff who
    // authorized managerOverride — forwarded to process_direct_sale_atomic's
    // p_manager_pin so the server independently re-derives the authorizing
    // staff from the PIN itself, never from the caller's own identity.
    managerPin: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.method == null) === (data.legs == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one payment method or split legs',
      });
    }
    if (data.method === 'cash' && data.tenderedAmount == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tenderedAmount is required for cash' });
    }
    if (data.method === 'bank_transfer' && !data.customerPhone?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customerPhone is required for bank_transfer',
      });
    }
  });

type RpcResult = {
  ok: boolean;
  idempotent?: boolean;
  tabId?: string;
  paymentId?: string;
  paymentGroupId?: string;
  paymentIds?: string[];
  code?: string;
  message?: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    status,
  });
}

type SaleReceiptPayment = {
  amount: number;
  method: 'cash' | 'card' | 'bank_transfer' | 'rappi' | 'uber_eats';
  processed_at: string;
  tendered_amount: number | null;
  reference_number: string | null;
  discount_scope: 'all' | null;
  discount_type: 'percent' | 'fixed' | null;
  discount_value: number | null;
  discount_amount: number | null;
};

/**
 * Builds ONE sale-level receipt for a tab, whether it was paid with a single
 * tender or split across multiple legs (Phase 2 gap closure, CHK-04 / CR-03).
 * The basket (`items`) is composed once from `order_items`; every payment
 * row for the tab becomes one entry in `tenders`, so a split sale never
 * repeats the basket per leg or shows a single leg's amount as the total.
 *
 * Defense-in-depth authorization (CHK-03 / T-02-07-01): every read is
 * additionally filtered by the authenticated staff/shift/Caja identity the
 * caller supplied. `process_direct_sale_atomic` already refuses to return a
 * tabId/paymentId to an unauthorized caller (idempotency replay is bound to
 * that identity before lookup — see 20260816000001_direct_sale_authoritative_totals.sql),
 * so this filter should never actually exclude a legitimately-returned tab;
 * it exists so a future regression at the RPC boundary cannot alone leak
 * another cashier's receipt data through this service-role read.
 */
async function buildSaleReceipt(
  admin: ReturnType<typeof createClient>,
  tabId: string,
  staffId: string,
  shiftId: string,
  cajaSessionId: string
) {
  const [{ data: tab }, { data: cashier }, { data: payments }, { data: orders }] =
    await Promise.all([
      admin
        .from('tabs')
        .select('customer_name')
        .eq('id', tabId)
        .eq('staff_id', staffId)
        .eq('shift_id', shiftId)
        .eq('caja_session_id', cajaSessionId)
        .maybeSingle(),
      admin.from('profiles').select('name').eq('id', staffId).maybeSingle(),
      admin
        .from('payments')
        .select(
          'amount, method, processed_at, tendered_amount, reference_number, discount_scope, discount_type, discount_value, discount_amount'
        )
        .eq('tab_id', tabId)
        .order('processed_at', { ascending: true }),
      admin
        .from('orders')
        .select(
          'status, order_items(quantity, unit_price, modifier_price_delta, weight_grams, promotion_id, discount_rate, discount_amount, products(name, category_id, categories(name)))'
        )
        .eq('tab_id', tabId),
    ]);
  // Empty/missing filtered results mean the caller does not own this sale
  // under the supplied staff/shift/Caja identity -- fail closed with no
  // tab/payment/receipt identifiers rather than falling back to an
  // unfiltered read.
  if (!tab || !payments || payments.length === 0 || !orders) return null;

  const items = (
    orders as {
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
    }[]
  )
    .filter(order => order.status !== 'voided')
    .flatMap(order => order.order_items ?? [])
    .map(item => ({
      name: item.products?.name ?? 'Item',
      quantity: item.quantity,
      unitPrice: Number(item.unit_price) + Number(item.modifier_price_delta),
      lineTotal:
        Math.round(
          (Number(item.unit_price) + Number(item.modifier_price_delta)) *
            Number(item.quantity) *
            100
        ) / 100,
      categoryId: item.products?.category_id ?? null,
      categoryName: item.products?.categories?.name ?? null,
      modifierNames: [],
      weightGrams: item.weight_grams ?? null,
      promotionId: item.promotion_id ?? null,
      discountRate: item.discount_rate == null ? null : Number(item.discount_rate),
      discountAmount: item.discount_amount == null ? null : Number(item.discount_amount),
    }));

  const legs = payments as SaleReceiptPayment[];
  const tenders = legs.map(leg => {
    const amount = Number(leg.amount);
    const tenderedAmount = leg.tendered_amount == null ? null : Number(leg.tendered_amount);
    return {
      method: leg.method,
      amount,
      tenderedAmount,
      changeAmount: tenderedAmount == null ? null : Math.round((tenderedAmount - amount) * 100) / 100,
      terminalReference: leg.reference_number ?? undefined,
    };
  });

  // The sale total is computed once from every persisted tender leg, never
  // from a single payment row -- this is the fix for CR-03 (a split sale
  // previously showed one leg's amount as the whole sale's total).
  const chargedAmount = Math.round(legs.reduce((sum, leg) => sum + Number(leg.amount), 0) * 100) / 100;
  // legs.length > 0 is guaranteed by the payments.length===0 guard above.
  const firstLeg = legs[0]!;
  const soleTender = legs.length === 1 ? tenders[0] : undefined;
  const discountLeg = legs.find(leg => leg.discount_amount != null);

  // Phase 24 (TAX-05): decompose the charged amount into subtotal/tax using
  // the same settings.billing row process_direct_sale_atomic already read
  // server-side — receiptData.subtotal was never actually a pre-tax figure
  // before this (Pitfall 2), it was set equal to `total`.
  const { data: billingRow } = await admin
    .from('settings')
    .select('value')
    .eq('key', 'billing')
    .maybeSingle();
  const billing = billingRow?.value as { taxRatePercent?: number; taxInclusive?: boolean } | null;
  const taxRatePercent = billing?.taxRatePercent ?? 16;
  const taxInclusive = billing?.taxInclusive ?? true;
  const { subtotal, taxAmount, total } = decomposeTax(chargedAmount, taxRatePercent, taxInclusive);

  return {
    receiptNumber: tabId.slice(0, 8).toUpperCase(),
    tabId,
    customerName: tab.customer_name ?? 'Walk-in',
    items,
    subtotal,
    taxAmount,
    taxRatePercent,
    taxInclusive,
    total,
    // Single-tender-compatible fields, derived from the sole tender leg when
    // there is exactly one; the `tenders` array below is authoritative for
    // split sales.
    paymentMethod: firstLeg.method,
    processedAt: firstLeg.processed_at,
    squareReceiptUrl: null,
    cashierName: cashier?.name ?? 'Staff',
    storeName: Deno.env.get('BAR_NAME') ?? 'Supermarket POS',
    barAddress: Deno.env.get('BAR_ADDRESS') ?? '',
    tenderedAmount: soleTender?.tenderedAmount ?? null,
    changeAmount: soleTender?.changeAmount ?? null,
    terminalReference: soleTender?.terminalReference,
    discountAmount:
      discountLeg?.discount_amount == null ? undefined : Number(discountLeg.discount_amount),
    discountScope: discountLeg?.discount_scope ?? undefined,
    discountType: discountLeg?.discount_type ?? undefined,
    discountValue:
      discountLeg?.discount_value == null ? undefined : Number(discountLeg.discount_value),
    tenders,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')
    return jsonResponse(
      { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } },
      405
    );

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer '))
    return jsonResponse(
      { success: false, error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } },
      401
    );
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey)
    return jsonResponse(
      { success: false, error: { code: 'CONFIG', message: 'Server misconfigured' } },
      500
    );

  // admin.auth.getUser() cannot verify the local stack's ES256 JWTs.
  const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: supabaseAnonKey },
  });
  if (!authResponse.ok)
    return jsonResponse(
      { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid session' } },
      401
    );
  const authUser = (await authResponse.json()) as { id: string };

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success)
    return jsonResponse(
      { success: false, error: { code: 'VALIDATION_ERROR', message: body.error.message } },
      400
    );
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await admin.rpc('process_direct_sale_atomic', {
    p_staff_id: authUser.id,
    p_shift_id: body.data.shiftId,
    p_caja_session_id: body.data.cajaSessionId,
    p_items: body.data.items.map(item => ({
      product_id: item.productId,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      modifier_ids: item.modifierIds,
      modifier_price_delta: item.modifierPriceDelta,
      ...(item.weightGrams != null ? { weight_grams: item.weightGrams } : {}),
      notes: item.notes ?? '',
    })),
    p_idempotency_key: body.data.idempotencyKey,
    p_method: body.data.method ?? null,
    p_amount: body.data.amount ?? null,
    p_tendered_amount: body.data.tenderedAmount ?? null,
    p_reference_number: body.data.referenceNumber?.trim() || null,
    p_legs:
      body.data.legs?.map(leg => ({
        method: leg.method,
        amount: leg.amount,
        ...(leg.tenderedAmount != null ? { tenderedAmount: leg.tenderedAmount } : {}),
        ...(leg.referenceNumber ? { referenceNumber: leg.referenceNumber } : {}),
      })) ?? null,
    p_expected_total: body.data.expectedTotal ?? null,
    p_discount_scope: body.data.discountScope ?? null,
    p_discount_type: body.data.discountType ?? null,
    p_discount_value: body.data.discountValue ?? null,
    p_discount_amount: body.data.discountAmount ?? null,
    p_customer_name: body.data.customerName ?? 'Walk-in',
    p_customer_phone: body.data.customerPhone ?? null,
    p_manager_override: body.data.managerOverride ?? false,
    p_manager_pin: body.data.managerPin ?? null,
  });
  if (error)
    return jsonResponse(
      { success: false, error: { code: 'RPC_ERROR', message: error.message } },
      500
    );
  const rpc = data as RpcResult;
  if (!rpc?.ok || !rpc.tabId || (body.data.legs ? !rpc.paymentIds?.length : !rpc.paymentId)) {
    return jsonResponse(
      {
        success: false,
        error: { code: rpc?.code ?? 'PAYMENT_FAILED', message: rpc?.message ?? 'Payment failed' },
      },
      409
    );
  }

  // One sale-level receipt for both direct and split-tender sales (CR-03):
  // the basket is composed once and every payment leg appears in
  // receiptData.tenders. buildSaleReceipt additionally filters every read
  // by the authenticated staff/shift/Caja identity (CR-02 defense in
  // depth) before returning any tab/payment/receipt data.
  const receiptData = await buildSaleReceipt(
    admin,
    rpc.tabId,
    authUser.id,
    body.data.shiftId,
    body.data.cajaSessionId
  );
  if (!receiptData)
    return jsonResponse(
      { success: false, error: { code: 'RECEIPT_FETCH', message: 'Could not load receipt' } },
      500
    );
  return jsonResponse({
    success: true,
    tabId: rpc.tabId,
    ...(rpc.paymentId ? { paymentId: rpc.paymentId } : {}),
    ...(rpc.paymentGroupId ? { paymentGroupId: rpc.paymentGroupId } : {}),
    ...(rpc.paymentIds ? { paymentIds: rpc.paymentIds } : {}),
    receiptData,
    idempotent: rpc.idempotent === true,
  });
});
