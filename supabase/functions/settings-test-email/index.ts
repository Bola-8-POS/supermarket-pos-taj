import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts';
import { verifyCaller } from '../_shared/caller.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fail } from '../_shared/errors.ts';

const BodySchema = z.object({
  email: z.string().trim().email(),
});

function methodsHeader(req: Request): Record<string, string> {
  return { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...methodsHeader(req) },
  });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: methodsHeader(req) });
  if (req.method !== 'POST') {
    return fail(req, 405, 'METHOD_NOT_ALLOWED', { envelope: 'ok' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey || !resendApiKey) {
    return fail(req, 500, 'CONFIG', { envelope: 'ok' });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const caller = await verifyCaller(req, admin);
  if (!caller.ok) {
    return fail(req, caller.status, caller.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', { envelope: 'ok' });
  }
  if (caller.role !== 'admin') {
    return fail(req, 403, 'FORBIDDEN', { envelope: 'ok', message: 'Admin access required' });
  }

  let bodyRaw: unknown;
  try {
    bodyRaw = await req.json();
  } catch {
    return fail(req, 400, 'INVALID_JSON', { envelope: 'ok' });
  }

  const parsed = BodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'ok', message: 'Invalid email' });
  }

  const { data: emailSetting } = await userClient
    .from('settings')
    .select('value')
    .eq('key', 'email_receipts')
    .maybeSingle();

  const value = emailSetting?.value as { fromEmail?: unknown } | null;
  const fromEmailSetting =
    value != null && typeof value.fromEmail === 'string' ? value.fromEmail.trim() : '';
  const fromEmailEnv = (Deno.env.get('RECEIPT_FROM_EMAIL') ?? '').trim();
  const fromEmail = fromEmailSetting || fromEmailEnv;
  if (fromEmail.length === 0) {
    return fail(req, 500, 'CONFIG', { envelope: 'ok', message: 'No from-email configured in settings or env' });
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [parsed.data.email],
      subject: 'POS settings test email',
      text: 'This is a test email from your POS settings page.',
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return fail(req, 502, 'RESEND_ERROR', { envelope: 'ok', detail });
  }

  return json(req, { ok: true });
});
