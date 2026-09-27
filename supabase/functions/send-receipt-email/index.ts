// Supabase Edge Function — send-receipt-email (Deno)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts';
import { recordAudit } from '../_shared/audit.ts';
import { verifyCaller } from '../_shared/caller.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fail } from '../_shared/errors.ts';
import { rateLimit } from '../_shared/rate_limit.ts';

const BodySchema = z.object({
  email: z.string().trim().email(),
  receiptPlainText: z.string().min(1).max(50_000),
  pdfBase64: z.string().max(2_000_000).optional(),
});

// Env-configurable instead of hardcoded, next to AGENT_ALLOWED_MODELS.
const DEFAULT_DAILY_LIMIT = 50;
const RATE_LIMIT_WINDOW_SECONDS = 86_400;

function methodsHeader(req: Request): Record<string, string> {
  return { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...methodsHeader(req) },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: methodsHeader(req) });
  if (req.method !== 'POST') {
    return fail(req, 405, 'METHOD_NOT_ALLOWED', { envelope: 'nested' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return fail(req, 500, 'CONFIG', { envelope: 'nested' });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const caller = await verifyCaller(req, admin);
  if (!caller.ok) {
    return fail(req, caller.status, caller.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', { envelope: 'nested' });
  }
  // Any active role except kitchen may email a receipt.
  if (caller.role === 'kitchen') {
    return fail(req, 403, 'FORBIDDEN', { envelope: 'nested' });
  }

  // A non-numeric override (e.g. a typo'd env value) falls back to the
  // default instead of sending NaN into rate_limit_hit, which would raise
  // INVALID_ARGUMENT and turn every receipt email into a 500.
  const parsedLimit = Number(Deno.env.get('RECEIPT_EMAIL_DAILY_LIMIT'));
  const dailyLimit = Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_DAILY_LIMIT;
  const limitResult = await rateLimit(admin, `receipt-email:${caller.id}`, dailyLimit, RATE_LIMIT_WINDOW_SECONDS);
  if (!limitResult.ok) {
    return fail(req, 500, 'INTERNAL', { envelope: 'nested', detail: 'rate_limit_hit failed' });
  }
  if (limitResult.retryAfter > 0) {
    return fail(req, 429, 'RATE_LIMITED', { envelope: 'nested', extra: { retryAfter: limitResult.retryAfter } });
  }

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return fail(req, 400, 'INVALID_JSON', { envelope: 'nested' });
  }

  const parsed = BodySchema.safeParse(bodyJson);
  if (!parsed.success) {
    return fail(req, 400, 'VALIDATION_ERROR', {
      envelope: 'nested',
      message: parsed.error.flatten().fieldErrors.email?.[0] ?? 'Invalid request',
    });
  }

  const body = parsed.data;
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('RECEIPT_FROM_EMAIL');

  if (!apiKey || !fromEmail) {
    return fail(req, 500, 'CONFIG', { envelope: 'nested', message: 'RESEND_API_KEY or RECEIPT_FROM_EMAIL not set' });
  }

  const resendPayload: Record<string, unknown> = {
    from: fromEmail,
    to: [body.email],
    subject: 'Your receipt',
    text: body.receiptPlainText,
  };
  if (body.pdfBase64) {
    resendPayload['attachments'] = [{ content: body.pdfBase64, filename: 'receipt.pdf' }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(resendPayload),
  });

  if (!res.ok) {
    const detail = await res.text();
    return fail(req, 502, 'RESEND_ERROR', { envelope: 'nested', detail });
  }

  // Known limit: BodySchema carries no paymentId/tabId today, so the
  // audit row records the recipient with a null entity id until a future
  // request-shape change.
  await recordAudit(admin, {
    action: 'receipt.emailed',
    entityType: 'receipt',
    entityId: null,
    before: null,
    after: { recipient: body.email },
    source: 'edge',
    actorId: caller.id,
  });

  return jsonResponse(req, { success: true });
});
