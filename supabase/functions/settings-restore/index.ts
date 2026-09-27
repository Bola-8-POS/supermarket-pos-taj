import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts';

import { recordAudit } from '../_shared/audit.ts';
import { verifyCaller } from '../_shared/caller.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fail } from '../_shared/errors.ts';

const BodySchema = z.object({
  backupId: z.string().uuid(),
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

// The RPC raises 'CODE: detail' on refusal; the code prefix maps to an HTTP
// status the same way a database error already mapped to one here before
// this wave (the RPC now does the whole restore transactionally, including
// reading the snapshot itself).
function statusForRpcMessage(message: string | undefined): number {
  if (message?.startsWith('NOT_FOUND')) return 404;
  if (message?.startsWith('FORBIDDEN')) return 403;
  return 500;
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
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'ok', message: 'Invalid backup id' });
  }

  // settings_restore_snapshot reads the snapshot itself (FOR UPDATE) and
  // applies the whole restore in one transaction — no separate
  // fetch-the-backup step here anymore.
  const { error } = await serviceClient.rpc('settings_restore_snapshot', {
    p_backup_id: parsed.data.backupId,
    p_actor: caller.id,
  });

  if (error) {
    const status = statusForRpcMessage(error.message);
    const code = error.message?.startsWith('NOT_FOUND') ? 'NOT_FOUND' : error.message?.startsWith('FORBIDDEN') ? 'FORBIDDEN' : 'RESTORE_FAILED';
    return fail(req, status, code, { envelope: 'ok', detail: error.message });
  }

  await recordAudit(serviceClient, {
    action: 'settings.update',
    entityType: 'settings',
    entityId: null,
    before: null,
    after: { backupId: parsed.data.backupId },
    source: 'edge',
    actorId: caller.id,
  });

  return json(req, { ok: true });
});
