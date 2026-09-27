import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts';
import { verifyCaller } from '../_shared/caller.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fail } from '../_shared/errors.ts';

const BodySchema = z.object({
  label: z.string().trim().min(1).max(120),
});

// Verbatim against SettingsKeySchema (src/shared/lib/domain.ts:853-861).
const SETTINGS_ALLOW_LIST = ['general', 'billing', 'email_receipts', 'pool_tables', 'receipt', 'payment_labels', 'near_expiry'];

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
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return fail(req, 500, 'CONFIG', { envelope: 'ok' });
  }
  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const caller = await verifyCaller(req, serviceClient);
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
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'ok', message: 'Backup label is required' });
  }

  const [settingsRes, categoriesRes, productsRes, modifiersRes, productModifiersRes] = await Promise.all([
    serviceClient.from('settings').select('*').in('key', SETTINGS_ALLOW_LIST).order('key'),
    serviceClient.from('categories').select('*').order('sort_order'),
    serviceClient.from('products').select('*').order('name'),
    serviceClient.from('modifiers').select('*').order('sort_order'),
    serviceClient.from('product_modifiers').select('*'),
  ]);

  if (settingsRes.error || categoriesRes.error || productsRes.error || modifiersRes.error || productModifiersRes.error) {
    return fail(req, 500, 'DB_ERROR', {
      envelope: 'ok',
      message: 'Could not collect backup data',
      detail:
        settingsRes.error?.message ??
        categoriesRes.error?.message ??
        productsRes.error?.message ??
        modifiersRes.error?.message ??
        productModifiersRes.error?.message,
    });
  }

  const snapshot = {
    settings: settingsRes.data,
    categories: categoriesRes.data,
    products: productsRes.data,
    modifiers: modifiersRes.data,
    product_modifiers: productModifiersRes.data,
  };

  const { data: backup, error: backupError } = await serviceClient
    .from('settings_backups')
    .insert({
      label: parsed.data.label,
      snapshot,
      created_by: caller.id,
    })
    .select('id')
    .single();

  if (backupError || !backup) {
    return fail(req, 500, 'DB_ERROR', { envelope: 'ok', message: 'Could not create backup record', detail: backupError?.message });
  }

  return json(req, { ok: true, backupId: backup.id });
});
