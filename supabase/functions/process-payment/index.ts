// Supabase Edge Function — process-payment (Deno)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts';
import { decomposeTax } from '../_shared/tax.ts';

const BodySchema = z
  .object({
    tabId: z.string().uuid(),
    amount: z.number().nonnegative().multipleOf(0.01),
    method: z.enum(['cash', 'card', 'rappi', 'uber_eats']),
    idempotencyKey: z.string().min(1).max(255),
    tenderedAmount: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
    referenceNumber: z.string().max(64).nullable().optional(),
    rappiOrderId: z.string().max(128).nullable().optional(),
    // Phase 15 gap-closure (D-02): cached tab.version for optimistic-concurrency guard.
    expectedVersion: z.number().int().nonnegative().optional(),
    // Phase 27 Plan 09 (G-27-13): ad-hoc discount + manager-PIN re-verification,
    // mirroring process-direct-sale/index.ts's BodySchema shape exactly.
    discountScope: z.enum(['all']).optional(),
    discountType: z.enum(['percent', 'fixed']).optional(),
    discountValue: z.number().nonnegative().optional(),
    discountAmount: z.number().nonnegative().multipleOf(0.01).optional(),
    managerOverride: z.boolean().optional(),
    managerPin: z.string().optional(),
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

type RpcResult = {
  ok: boolean;
  idempotent?: boolean;
  paymentId?: string;
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

  const { data: rpcData, error: rpcError } = await admin.rpc('process_payment_atomic', {
    p_tab_id: body.tabId,
    p_staff_id: authUser.id,
    p_amount: body.amount,
    p_method: body.method,
    p_idempotency_key: body.idempotencyKey,
    p_tendered_amount: body.tenderedAmount ?? null,
    p_reference_number: body.referenceNumber?.trim() ? body.referenceNumber.trim() : null,
    p_rappi_order_id: body.rappiOrderId?.trim() ? body.rappiOrderId.trim() : null,
    ...(body.expectedVersion !== undefined ? { p_expected_version: body.expectedVersion } : {}),
    p_discount_scope: body.discountScope ?? null,
    p_discount_type: body.discountType ?? null,
    p_discount_value: body.discountValue ?? null,
    p_discount_amount: body.discountAmount ?? null,
    // ?? false, not ?? null: process_payment_atomic's `IF p_manager_override
    // THEN` / `IF NOT p_manager_override THEN` guard treats a NULL boolean as
    // neither branch, silently skipping the DISCOUNT_REQUIRES_MANAGER check
    // (CR-01, Phase 27 code review).
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
  if (!rpc || typeof rpc !== 'object' || rpc.ok !== true || !rpc.paymentId) {
    const code = rpc?.code ?? 'PAYMENT_FAILED';
    const message = rpc?.message ?? 'Payment failed';
    return jsonResponse({ success: false, error: { code, message } }, statusForCode(code));
  }

  const paymentId = rpc.paymentId;

  const storeName = Deno.env.get('BAR_NAME') ?? 'Bar';
  const barAddress = Deno.env.get('BAR_ADDRESS') ?? '';

  const { data: paymentRow, error: payErr } = await admin
    .from('payments')
    .select(
      'id, amount, method, processed_at, tendered_amount, reference_number, discount_scope, discount_type, discount_value, discount_amount'
    )
    .eq('id', paymentId)
    .single();

  if (payErr || !paymentRow) {
    return jsonResponse({ success: false, error: { code: 'PAYMENT_FETCH', message: 'Could not load payment' } }, 500);
  }

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
        modifier_ids,
        promotion_id,
        discount_rate,
        discount_amount,
        products ( name, category_id, categories ( name ) )
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
    modifier_ids: string[] | null;
    promotion_id: string | null;
    discount_rate: number | null;
    discount_amount: number | null;
    products: { name: string; category_id: string | null; categories: { name: string } | null } | null;
  };
  type Or = {
    id: string;
    status: string;
    order_items: Oi[] | null;
  };

  const nonVoidedOrders = (orderRows ?? []).filter((order) => (order as Or).status !== 'voided') as Or[];

  // Modifiers are stored as order_items.modifier_ids (uuid[]), not a junction
  // table — batch-resolve names in one query rather than per-item.
  const allModifierIds = Array.from(
    new Set(nonVoidedOrders.flatMap((order) => (order.order_items ?? []).flatMap((oi) => oi.modifier_ids ?? [])))
  );
  const modifierNameById = new Map<string, string>();
  if (allModifierIds.length > 0) {
    const { data: modifierRows, error: modifierErr } = await admin
      .from('modifiers')
      .select('id, name')
      .in('id', allModifierIds);
    if (modifierErr) {
      console.error('[process-payment] Failed to resolve modifier names:', modifierErr.message);
    } else {
      for (const m of (modifierRows ?? []) as { id: string; name: string }[]) {
        modifierNameById.set(m.id, m.name);
      }
    }
  }

  const items: {
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    categoryId: string | null;
    categoryName: string | null;
    modifierNames: string[];
    promotionId: string | null;
    discountRate: number | null;
    discountAmount: number | null;
  }[] = [];

  for (const order of nonVoidedOrders) {
    for (const oi of order.order_items ?? []) {
      const name = oi.products?.name ?? 'Item';
      const lineTotal = (Number(oi.unit_price) + Number(oi.modifier_price_delta)) * Number(oi.quantity);
      items.push({
        name,
        quantity: oi.quantity,
        unitPrice: Number(oi.unit_price) + Number(oi.modifier_price_delta),
        lineTotal: Math.round(lineTotal * 100) / 100,
        categoryId: oi.products?.category_id ?? null,
        categoryName: oi.products?.categories?.name ?? null,
        modifierNames: (oi.modifier_ids ?? [])
          .map((id) => modifierNameById.get(id))
          .filter((n): n is string => typeof n === 'string'),
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
      categoryId: null,
      categoryName: null,
      modifierNames: [],
      promotionId: null,
      discountRate: null,
      discountAmount: null,
    });
  }

  const { data: billingRow } = await admin.from('settings').select('value').eq('key', 'billing').maybeSingle();
  const billing = billingRow?.value as { taxRatePercent?: number; taxInclusive?: boolean } | null;
  const taxRatePercent = billing?.taxRatePercent ?? 16;
  const taxInclusive = billing?.taxInclusive ?? true;
  const { subtotal, taxAmount, total } = decomposeTax(body.amount, taxRatePercent, taxInclusive);
  const tendered = paymentRow.tendered_amount != null ? Number(paymentRow.tendered_amount) : null;
  const changeAmount =
    tendered != null ? Math.round((tendered - total) * 100) / 100 : null;

  const ref = paymentRow.reference_number as string | null;

  const receiptData = {
    receiptNumber: paymentId.slice(0, 8).toUpperCase(),
    tabId: body.tabId,
    customerName: tabRow.customer_name ?? 'Guest',
    items,
    subtotal,
    total,
    taxAmount,
    taxRatePercent,
    taxInclusive,
    paymentMethod: paymentRow.method,
    processedAt: paymentRow.processed_at,
    squareReceiptUrl: null as string | null,
    cashierName: cashierRow?.name ?? 'Staff',
    storeName,
    barAddress,
    tenderedAmount: tendered,
    changeAmount,
    terminalReference: ref && ref.length > 0 ? ref : undefined,
    discountAmount:
      paymentRow.discount_amount == null ? undefined : Number(paymentRow.discount_amount),
    discountScope: paymentRow.discount_scope ?? undefined,
    discountType: paymentRow.discount_type ?? undefined,
    discountValue:
      paymentRow.discount_value == null ? undefined : Number(paymentRow.discount_value),
  };

  return jsonResponse({
    success: true,
    paymentId,
    receiptData,
    idempotent: rpc.idempotent === true,
  });
});
