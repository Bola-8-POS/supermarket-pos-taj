// Deactivate or reactivate a staff member. The profile flips through the
// set_staff_active RPC (row lock, last-admin rule, audit row); the Auth user
// is banned or unbanned so the account cannot sign in or refresh a session.
// Deactivate: RPC first, then ban. Activate: unban first, then RPC. Either
// order leaves the account unable to act when the second step fails.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'
import { recordAudit } from '../_shared/audit.ts'
import { verifyCaller } from '../_shared/caller.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { fail } from '../_shared/errors.ts'

const BodySchema = z.object({
  staffId: z.string().uuid(),
  active: z.boolean(),
  terminalId: z.string().optional(),
})

// Long enough to outlive any session; 'none' lifts it.
const BAN_DURATION = '876000h'

function methodsHeader(req: Request): Record<string, string> {
  return { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...methodsHeader(req) },
  })
}

const RPC_STATUS: Record<string, number> = { NOT_FOUND: 404, SELF: 400, LAST_ADMIN: 409 }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: methodsHeader(req) })
  if (req.method !== 'POST') return fail(req, 405, 'METHOD_NOT_ALLOWED', { envelope: 'flat' })

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const caller = await verifyCaller(req, admin)
  if (!caller.ok) return fail(req, caller.status, caller.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', { envelope: 'flat' })

  const { data: permission, error: permissionError } = await admin
    .from('role_permissions')
    .select('id')
    .eq('role', caller.role)
    .eq('action', 'manage_staff')
    .maybeSingle()
  if (!permission) {
    console.error(
      'set-staff-active: manage_staff permission refused',
      caller.id,
      permissionError?.message ?? `role ${caller.role} lacks manage_staff`
    )
    return fail(req, 403, 'FORBIDDEN', { envelope: 'flat' })
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'flat' })
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'flat' })
  const { staffId, active, terminalId } = parsed.data

  const setBan = (banned: boolean) =>
    admin.auth.admin.updateUserById(staffId, { ban_duration: banned ? BAN_DURATION : 'none' })
  const flip = () =>
    admin.rpc('set_staff_active', {
      p_staff_id: staffId,
      p_active: active,
      p_actor_id: caller.id,
      p_terminal_id: terminalId ?? null,
    })

  if (active) {
    const { error: unbanError } = await setBan(false)
    if (unbanError) {
      console.error('set-staff-active: sign-in state update failed', unbanError.message)
      return fail(req, 500, 'SIGN_IN_STATE_FAILED', { envelope: 'flat', detail: unbanError.message })
    }
  }

  const { data, error: rpcError } = await flip()
  const outcome = (data ?? { ok: false }) as { ok: boolean; code?: string; changed?: boolean }
  if (rpcError || !outcome.ok) {
    if (active) {
      // The record did not flip. When the target is still inactive, put the
      // ban back so the account stays unable to sign in. (A SELF refusal
      // names the active caller, whose ban must not be touched.)
      const { data: target, error: targetError } = await admin.from('profiles').select('is_active').eq('id', staffId).maybeSingle()
      if (targetError) console.error('set-staff-active: target read failed, ban not restored', targetError.message)
      if (target && target.is_active === false) {
        const { error: rebanError } = await setBan(true)
        if (rebanError) console.error('set-staff-active: ban restore failed', rebanError.message)
      }
    }
    if (rpcError) {
      console.error('set-staff-active: staff record update failed', rpcError.message)
      return fail(req, 500, 'STAFF_RECORD_FAILED', { envelope: 'flat', detail: rpcError.message })
    }
    return fail(req, RPC_STATUS[outcome.code ?? ''] ?? 500, outcome.code ?? 'SET_ACTIVE_FAILED', { envelope: 'flat' })
  }

  if (!active) {
    // Runs even when the record was already inactive, so a retry after a
    // partial failure completes the ban.
    const { error: banError } = await setBan(true)
    if (banError) {
      console.error('set-staff-active: sign-in state update failed', banError.message)
      await recordAudit(admin, {
        action: 'staff.deactivate',
        entityType: 'staff',
        entityId: staffId,
        before: null,
        after: { partialFailure: true, profileUpdated: true, signInStateFailed: true },
        source: 'edge',
        actorId: caller.id,
        terminalId,
      })
      return fail(
        req,
        500,
        'PARTIAL_FAILURE: staff record updated but sign-in state failed to sync, retry',
        { envelope: 'flat', detail: banError.message }
      )
    }
  }

  return json(req, { ok: true, changed: outcome.changed === true })
})
