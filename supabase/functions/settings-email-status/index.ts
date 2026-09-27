import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
import { callerHasAction, verifyCaller } from '../_shared/caller.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fail } from '../_shared/errors.ts';

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
  if (req.method !== 'POST') return fail(req, 405, 'METHOD_NOT_ALLOWED', { envelope: 'ok' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return fail(req, 500, 'CONFIG', { envelope: 'ok' });
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // manage_settings gate (was a hard-coded admin/manager role literal).
  const caller = await verifyCaller(req, admin);
  if (!caller.ok) {
    return fail(req, caller.status, caller.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', { envelope: 'ok' });
  }
  if (!(await callerHasAction(admin, caller.role, 'manage_settings'))) {
    return fail(req, 403, 'FORBIDDEN', { envelope: 'ok' });
  }

  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  const resendConfigured = typeof resendApiKey === 'string' && resendApiKey.length > 0;

  return json(req, { ok: true, resendConfigured });
});
