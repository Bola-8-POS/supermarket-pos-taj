// Supabase Edge Function — agent-proxy (Deno)
//
// Phase 06 (SEC-01): thin, Bearer-authenticated pass-through proxy to the
// Anthropic Messages API. D-01 (locked): this is NOT a server-side agent
// loop — brain.ts's multi-turn tool loop and vision.ts/brain.ts's RAG
// context stay entirely client-side. This function only ever forwards one
// messages.create-shaped request and returns the raw Anthropic response.
//
// Superseding the D-03 (locked) comment this wave replaced — a role gate
// (admin/manager), a model allow-list, request caps and a rate limit are
// added on top of the existing Bearer-JWT auth.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts';
import { type AgentGuardEnv, checkAgentRequest } from '../_shared/agent_guard.ts';
import { verifyCaller } from '../_shared/caller.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fail } from '../_shared/errors.ts';
import { rateLimit } from '../_shared/rate_limit.ts';

function methodsHeader(req: Request): Record<string, string> {
  return { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}

// Forwarded opaquely (D-01's thin-proxy framing) — do not deeply validate
// message/tool internals or the model string.
const BodySchema = z.object({
  model: z.string(),
  max_tokens: z.number().int().positive(),
  system: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()),
});

// The same literal is brain.ts:36's and vision.ts:9-11's client-side
// default model string — the allow-list default must match both, since
// vision.ts's menu-photo extraction calls this proxy too.
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const RATE_LIMIT_WINDOW_SECONDS = 3600;
// One chat message costs 1 proxy call plus up to MAX_TOOL_LOOPS=8 (brain.ts:45)
// tool-loop round trips, retried once on failure (brain.ts:147) -- up to
// 2*(1+8)=18 calls for one heavy message. 300/hour covers ~16 such messages
// an hour per user without materially loosening the guard on a runaway caller.
const RATE_LIMIT_PER_HOUR = 300;

function allowedModels(): string[] {
  const env = Deno.env.get('AGENT_ALLOWED_MODELS');
  if (!env) return [DEFAULT_MODEL];
  return env.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: methodsHeader(req) });
  }

  if (req.method !== 'POST') {
    return fail(req, 405, 'METHOD_NOT_ALLOWED', { envelope: 'nested' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return fail(req, 500, 'CONFIG', { envelope: 'nested' });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  const caller = await verifyCaller(req, admin);
  if (!caller.ok) {
    return fail(req, caller.status, caller.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', { envelope: 'nested' });
  }
  if (caller.role !== 'admin' && caller.role !== 'manager') {
    return fail(req, 403, 'FORBIDDEN', { envelope: 'nested' });
  }

  const limitResult = await rateLimit(admin, `agent:${caller.id}`, RATE_LIMIT_PER_HOUR, RATE_LIMIT_WINDOW_SECONDS);
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
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'nested', detail: parsed.error.flatten().fieldErrors });
  }

  const guardEnv: AgentGuardEnv = { allowedModels: allowedModels() };
  const guardError = checkAgentRequest(parsed.data, guardEnv);
  if (guardError) {
    return fail(req, 400, guardError.code, { envelope: 'nested', message: guardError.message });
  }

  const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!anthropicApiKey) {
    return fail(req, 500, 'CONFIG', { envelope: 'nested', message: 'ANTHROPIC_API_KEY not set' });
  }

  const body = parsed.data;

  let anthropicResp: Response;
  try {
    anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': anthropicApiKey,
      },
      body: JSON.stringify({
        model: body.model,
        max_tokens: body.max_tokens,
        system: body.system,
        tools: body.tools,
        messages: body.messages,
      }),
    });
  } catch (e) {
    return fail(req, 502, 'ANTHROPIC_ERROR', {
      envelope: 'nested',
      message: 'Upstream error',
      detail: e instanceof Error ? e.message : e,
    });
  }

  // Success path: forward the raw Anthropic response body UNCHANGED (same
  // status) — brain.ts/vision.ts read response.stop_reason/response.content
  // directly and would break against a wrapped {success, data} envelope.
  const anthropicBody: unknown = await anthropicResp.json().catch(() => null);

  if (!anthropicResp.ok) {
    // The upstream body is logged, never relayed — only the HTTP status is
    // kept.
    return fail(req, anthropicResp.status, 'ANTHROPIC_ERROR', {
      envelope: 'nested',
      message: 'Upstream error',
      detail: anthropicBody,
    });
  }

  return new Response(JSON.stringify(anthropicBody), {
    status: anthropicResp.status,
    headers: { 'Content-Type': 'application/json', ...methodsHeader(req) },
  });
});
