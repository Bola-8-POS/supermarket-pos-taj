// Supabase Edge Function — process-split-payment (Deno)
// Structural mirror of process-payment/index.ts (D-11: process-payment
// itself is untouched). Verifies the caller's JWT, calls
// process_split_payment_atomic (1-4 legs, atomic all-or-nothing close),
// then assembles one ReceiptData per leg (D-09).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts';
import { decomposeTax } from '../_shared/tax.ts';

const legSchema = z
  .object({
    method: z.enum(['cash', 'card', 'rappi', 'uber_eats']),
    amount: z.number().nonnegative().multipleOf(0.01),
    tenderedAmount: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
    referenceNumber: z.string().max(64).nullable().optional(),
    rappiOrderId: z.string().max(128).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.method === 'cash' && data.tenderedAmount == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tenderedAmount is required for cash',
        path: ['tenderedAmount'],
      });
    }
    if (data.method !== 'cash' && data.tenderedAmount != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tenderedAmount is only valid for cash',
        path: ['tenderedAmount'],
      });
    }
  });

const BodySchema = z
  .object({
    tabId: z.string().uuid(),
    legs: z.array(legSchema).min(1).max(4),
    expectedTotal: z.number().nonnegative().multipleOf(0.01),
    idempotencyKey: z.string().min(1).max(255),
    // Phase 27 Plan 09 (G-27-13) fix: these enums were bar-pos-era stale values
    // ('tab'/'item', 'percentage'/'fixed') that never matched what the client
    // actually sends (DiscountScopeSchema/DiscountTypeSchema in domain.ts:
    // 'all', 'percent'/'fixed') — every split-payment discount request was
    // silently rejected by Zod with 400 VALIDATION_ERROR before ever reaching
    // the RPC.
    discountScope: z.enum(['all']).nullable().optional(),
    discountType: z.enum(['percent', 'fixed']).nullable().optional(),
    discountValue: z.number().nonnegative().nullable().optional(),
    discountAmount: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
    managerOverride: z.boolean().nullable().optional(),
    managerPin: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const legsTotal = data.legs.reduce((sum, leg) => sum + leg.amount, 0);
    if (Math.abs(Math.round((legsTotal - data.expectedTotal) * 100) / 100) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Sum of leg amounts must equal expectedTotal',
        path: ['legs'],
      });
    }
  });

type RpcResult = {
  ok: boolean;
  idempotent?: boolean;
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
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function statusForCode(code: string | undefined): number {
  switch (code) {
    case 'FORBIDDEN':
    case 'IDEMPOTENCY_MISMATCH':
      return 403;
    case 'TAB_NOT_FOUND':
      return 404;
    case 'POOL_SESSION_ACTIVE':
    case 'TAB_NOT_OPEN':
    case 'AMOUNT_MISMATCH':
    case 'TENDERED_REQUIRED':
    case 'INSUFFICIENT_TENDER':
    case 'TENDERED_NOT_ALLOWED':
    case 'INVALID_METHOD':
    case 'SPLIT_TOTAL_MISMATCH':
    case 'TOO_MANY_LEGS':
    case 'EMPTY_LEG':
      return 409;
    default:
      return 400;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return jsonResponse({ success: false, error: { code: 'CONFIG', message: 'Server misconfigured' } }, 500);
  }

  // Verify the JWT via a direct HTTP call to /auth/v1/user.
  // admin.auth.getUser() in supabase-js@2.49.1 fails with ES256-signed tokens
  // ("Unsupported JWT algorithm ES256") because the bundled JWT library predates
  // Supabase's switch from RS256 → ES256. The Auth REST API handles ES256 correctly.
  const token = authHeader.slice(7); // strip "Bearer "
  const authVerifyResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': supabaseAnonKey,
    },
  });

  if (!authVerifyResp.ok) {
    return jsonResponse({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid session' } }, 401);
  }

  const authUser = await authVerifyResp.json() as { id: string };
  const admin = createClient(supabaseUrl, serviceRoleKey);

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return jsonResponse({ success: false, error: { code: 'INVALID_JSON', message: 'Body must be JSON' } }, 400);
  }

  const parsed = BodySchema.safeParse(bodyJson);
  if (!parsed.success) {
    return jsonResponse(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.flatten().fieldErrors
            ? JSON.stringify(parsed.error.flatten().fieldErrors)
            : 'Invalid request',
        },
      },
      400
    );
  }

  const body = parsed.data;

  const { data: rpcData, error: rpcError } = await admin.rpc('process_split_payment_atomic', {
    p_tab_id: body.tabId,
    p_staff_id: authUser.id,
    p_legs: body.legs,
    p_expected_total: body.expectedTotal,
    p_idempotency_key: body.idempotencyKey,
    p_discount_scope: body.discountScope ?? null,
    p_discount_type: body.discountType ?? null,
    p_discount_value: body.discountValue ?? null,
    p_discount_amount: body.discountAmount ?? null,
    // ?? false, not ?? null: process_split_payment_atomic's `IF
    // p_manager_override THEN` / `IF NOT p_manager_override THEN` guard
    // treats a NULL boolean as neither branch, silently skipping the
    // DISCOUNT_REQUIRES_MANAGER check (CR-01, Phase 27 code review).
    p_manager_override: body.managerOverride ?? false,
    p_manager_pin: body.managerPin ?? null,
  });

  if (rpcError) {
    return jsonResponse(
      {
        success: false,
        error: { code: 'RPC_ERROR', message: rpcError.message },
      },
      500
    );
  }

  const rpc = rpcData as RpcResult;
  if (!rpc || typeof rpc !== 'object' || rpc.ok !== true || !rpc.paymentGroupId) {
    const code = rpc?.code ?? 'PAYMENT_FAILED';
    const message = rpc?.message ?? 'Split payment failed';
    return jsonResponse({ success: false, error: { code, message } }, statusForCode(code));
  }

  const paymentGroupId = rpc.paymentGroupId;
  const paymentIds = rpc.paymentIds ?? [];

  const storeName = Deno.env.get('BAR_NAME') ?? 'Bar';
  const barAddress = Deno.env.get('BAR_ADDRESS') ?? '';

  const { data: tabRow, error: tabErr } = await admin
    .from('tabs')
    .select('customer_name')
    .eq('id', body.tabId)
    .single();

  if (tabErr || !tabRow) {
    return jsonResponse({ success: false, error: { code: 'TAB_FETCH', message: 'Could not load tab' } }, 500);
  }

  const { data: cashierRow } = await admin.from('profiles').select('name').eq('id', authUser.id).maybeSingle();

  const { data: orderRows, error: ordErr } = await admin
    .from('orders')
    .select(
      `
      id,
      status,
      order_items (
        quantity,
        unit_price,
        modifier_price_delta,
        promotion_id,
        discount_rate,
        discount_amount,
        products ( name )
      )
    `
    )
    .eq('tab_id', body.tabId);

  if (ordErr) {
    return jsonResponse({ success: false, error: { code: 'ORDERS_FETCH', message: ordErr.message } }, 500);
  }

  type Oi = {
    quantity: number;
    unit_price: number;
    modifier_price_delta: number;
    promotion_id: string | null;
    discount_rate: number | null;
    discount_amount: number | null;
    products: { name: string } | null;
  };
  type Or = {
    id: string;
    status: string;
    order_items: Oi[] | null;
  };

  // Items are shared across every leg's receipt (18-PATTERNS.md:
  // receipt-assembly-once-per-leg — the item/pool computation is run once
  // per tab, not once per leg).
  const items: {
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    promotionId: string | null;
    discountRate: number | null;
    discountAmount: number | null;
  }[] = [];

  for (const order of (orderRows ?? []) as Or[]) {
    if (order.status === 'voided') continue;
    for (const oi of order.order_items ?? []) {
      const name = oi.products?.name ?? 'Item';
      const lineTotal = (Number(oi.unit_price) + Number(oi.modifier_price_delta)) * Number(oi.quantity);
      items.push({
        name,
        quantity: oi.quantity,
        unitPrice: Number(oi.unit_price) + Number(oi.modifier_price_delta),
        lineTotal: Math.round(lineTotal * 100) / 100,
        promotionId: oi.promotion_id ?? null,
        discountRate: oi.discount_rate == null ? null : Number(oi.discount_rate),
        discountAmount: oi.discount_amount == null ? null : Number(oi.discount_amount),
      });
    }
  }

  const { data: poolRows } = await admin
    .from('pool_sessions')
    .select('billed_minutes, total_charge, pool_tables ( number, label )')
    .eq('tab_id', body.tabId)
    .not('stopped_at', 'is', null);

  type PoolR = {
    billed_minutes: number | null;
    total_charge: number | null;
    pool_tables: { number: number; label: string } | null;
  };

  for (const ps of (poolRows ?? []) as PoolR[]) {
    if (ps.total_charge == null || ps.billed_minutes == null) continue;
    const label = ps.pool_tables ? `Pool T${ps.pool_tables.number}` : 'Pool';
    items.push({
      name: `${label} (${ps.billed_minutes} min)`,
      quantity: 1,
      unitPrice: ps.total_charge,
      lineTotal: ps.total_charge,
      promotionId: null,
      discountRate: null,
      discountAmount: null,
    });
  }

  // Fetch all payment rows for the group, ordered by split_index — one row
  // per leg, each producing its own ReceiptData (D-09).
  const { data: paymentRows, error: payErr } = await admin
    .from('payments')
    .select(
      'id, amount, method, processed_at, tendered_amount, reference_number, split_index, discount_scope, discount_type, discount_value, discount_amount'
    )
    .eq('payment_group_id', paymentGroupId)
    .order('split_index');

  if (payErr || !paymentRows || paymentRows.length === 0) {
    return jsonResponse(
      { success: false, error: { code: 'PAYMENT_FETCH', message: 'Could not load split payments' } },
      500
    );
  }

  type PaymentLegRow = {
    id: string;
    amount: number;
    method: string;
    processed_at: string;
    tendered_amount: number | null;
    reference_number: string | null;
    split_index: number | null;
    discount_scope: string | null;
    discount_type: string | null;
    discount_value: number | null;
    discount_amount: number | null;
  };

  const customerName = tabRow.customer_name ?? 'Guest';
  const cashierName = cashierRow?.name ?? 'Staff';

  const { data: billingRow } = await admin.from('settings').select('value').eq('key', 'billing').maybeSingle();
  const billing = billingRow?.value as { taxRatePercent?: number; taxInclusive?: boolean } | null;
  const taxRatePercent = billing?.taxRatePercent ?? 16;
  const taxInclusive = billing?.taxInclusive ?? true;

  const receipts = (paymentRows as PaymentLegRow[]).map(legRow => {
    const { subtotal, taxAmount, total } = decomposeTax(
      Number(legRow.amount),
      taxRatePercent,
      taxInclusive
    );
    const tendered = legRow.tendered_amount != null ? Number(legRow.tendered_amount) : null;
    const changeAmount = tendered != null ? Math.round((tendered - total) * 100) / 100 : null;
    const ref = legRow.reference_number;

    return {
      receiptNumber: legRow.id.slice(0, 8).toUpperCase(),
      tabId: body.tabId,
      customerName,
      items,
      subtotal,
      total,
      taxAmount,
      taxRatePercent,
      taxInclusive,
      paymentMethod: legRow.method,
      processedAt: legRow.processed_at,
      squareReceiptUrl: null as string | null,
      cashierName,
      storeName,
      barAddress,
      tenderedAmount: tendered,
      changeAmount,
      terminalReference: ref && ref.length > 0 ? ref : undefined,
      discountAmount: legRow.discount_amount != null ? Number(legRow.discount_amount) : undefined,
      discountScope: legRow.discount_scope ?? undefined,
      discountType: legRow.discount_type ?? undefined,
      discountValue: legRow.discount_value != null ? Number(legRow.discount_value) : undefined,
    };
  });

  return jsonResponse({
    success: true,
    paymentGroupId,
    paymentIds,
    receipts,
    idempotent: rpc.idempotent === true,
  });
});
