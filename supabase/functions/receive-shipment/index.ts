import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { z } from 'https://esm.sh/zod@3.23.8';
import { verifyCaller } from '../_shared/caller.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fail, publicRpcMessage } from '../_shared/errors.ts';

const BodySchema = z.object({
  supplierId: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive().max(9999),
        costPrice: z.number().nonnegative(),
        expiryDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
      })
    )
    .min(1)
    .max(50),
  poId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().uuid().optional(),
});

function methodsHeader(req: Request): Record<string, string> {
  return { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...methodsHeader(req) } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: methodsHeader(req) });
  if (req.method !== 'POST') return fail(req, 405, 'METHOD_NOT_ALLOWED', { envelope: 'nested' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const caller = await verifyCaller(req, admin);
  if (!caller.ok) return fail(req, caller.status, caller.status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN', { envelope: 'nested' });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(req, 400, 'VALIDATION_ERROR', {
      envelope: 'nested',
      message: 'Invalid shipment request',
      detail: parsed.error.message,
    });
  }

  const { data, error } = await admin.rpc('receive_shipment', {
    p_staff_id: caller.id,
    p_supplier_id: parsed.data.supplierId,
    p_items: parsed.data.items.map(item => ({
      product_id: item.productId,
      quantity: item.quantity,
      cost_price: item.costPrice,
      expiry_date: item.expiryDate ?? null,
    })),
    p_po_id: parsed.data.poId ?? null,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  });
  if (error || !data?.ok) {
    const code = data?.code ?? 'RECEIVE_SHIPMENT_FAILED';
    return fail(req, code === 'FORBIDDEN' ? 403 : 400, code, {
      envelope: 'nested',
      message: publicRpcMessage(code, data?.message ?? error?.message),
    });
  }
  return json(req, { success: true, shipmentId: data.shipmentId, idempotent: data.idempotent });
});
