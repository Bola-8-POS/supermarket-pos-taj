// Deno runtime
import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'
import { recordAudit } from '../_shared/audit.ts'
import { callerHasAction, verifyCaller } from '../_shared/caller.ts'
import { writeCredential } from '../_shared/credentials.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { fail } from '../_shared/errors.ts'
import { deriveStaffPassword, staffPasswordPepper } from '../_shared/staff-password.ts'

const BodySchema = z.object({
  targetStaffId: z.string().uuid(),
  newPin: z.string().regex(/^\d{6}$/),
})

function methodsHeader(req: Request): Record<string, string> {
  return { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...methodsHeader(req) },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: methodsHeader(req) })
  if (req.method !== 'POST') return fail(req, 405, 'METHOD_NOT_ALLOWED', { envelope: 'flat' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Single admin client, reused for the caller check, target lookup and the
  // credential write below — don't construct two.
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const caller = await verifyCaller(req, supabaseAdmin)
  if (!caller.ok) return fail(req, caller.status, caller.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', { envelope: 'flat' })

  // manage_staff gate (was a hard-coded admin-only role literal), stricter
  // in practice than create-staff's gate: this is a live-credential
  // overwrite on an existing account, not account creation.
  if (!(await callerHasAction(supabaseAdmin, caller.role, 'manage_staff'))) return fail(req, 403, 'FORBIDDEN', { envelope: 'flat' })

  let bodyJson: unknown
  try {
    bodyJson = await req.json()
  } catch {
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'flat' })
  }

  const parsed = BodySchema.safeParse(bodyJson)
  if (!parsed.success) return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'flat' })
  const { targetStaffId, newPin } = parsed.data

  // D-06: target must exist and be active. No self-target special-case
  // anywhere in this function (D-08) — targetStaffId === caller.id is an
  // ordinary case, identical code path.
  const { data: targetProfile, error: targetLookupError } = await supabaseAdmin
    .from('profiles')
    .select('id, name, is_active, pin, must_change_pin')
    .eq('id', targetStaffId)
    .single()

  if (targetLookupError || !targetProfile) return fail(req, 404, 'NOT_FOUND', { envelope: 'flat' })
  if (!targetProfile.is_active) return fail(req, 400, 'INACTIVE', { envelope: 'flat' })

  const pepper = staffPasswordPepper()
  if (!pepper) return fail(req, 500, 'CONFIG', { envelope: 'flat', detail: 'STAFF_PASSWORD_PEPPER is not configured' })

  // Both credential stores in one operation, Auth first then profile: the old
  // (possibly leaked) PIN must never keep signing in. If the profile write fails
  // after Auth succeeded, Auth is not restored (the old password cannot be
  // re-derived from a hash); the admin retries the reset.
  const result = await writeCredential(
    {
      setPassword: async (id, pin) => {
        let password: string
        try {
          password = await deriveStaffPassword(id, pin, pepper)
        } catch (e) {
          return { error: { message: (e as Error).message } }
        }
        return await supabaseAdmin.auth.admin.updateUserById(id, { password })
      },
      updateProfile: async (id, patch) => await supabaseAdmin.from('profiles').update(patch).eq('id', id),
      profileHolds: async (id, patch) => {
        const { data: row } = await supabaseAdmin.from('profiles').select('must_change_pin').eq('id', id).single()
        if (!row || row.must_change_pin !== patch.must_change_pin) return false
        // profiles.pin is a hash: the comparison happens in the database.
        const { data: holders } = await supabaseAdmin.rpc('staff_ids_with_pin', { p_pin: patch.pin as string })
        return (holders ?? []).includes(id)
      },
    },
    {
      order: 'auth-first',
      userId: targetStaffId,
      newPin,
      profilePatch: { pin: newPin, must_change_pin: true },
      previousProfile: { pin: targetProfile.pin, must_change_pin: targetProfile.must_change_pin },
    }
  )

  if (!result.ok) {
    if (result.code === 'COMPENSATED') {
      // Auth was not changed, so nothing changed.
      await recordAudit(supabaseAdmin, {
        action: 'permission.admin_pin_reset',
        entityType: 'staff',
        entityId: targetStaffId,
        before: null,
        after: { failed: true, compensated: true },
        source: 'edge',
        actorId: caller.id,
      })
      return fail(req, 409, 'CREDENTIAL_WRITE_FAILED: nothing changed, try again', { envelope: 'flat' })
    }
    // Auth now holds the new PIN but the staff record did not follow: the old
    // PIN no longer signs in. Retrying the reset completes it.
    await recordAudit(supabaseAdmin, {
      action: 'permission.admin_pin_reset',
      entityType: 'staff',
      entityId: targetStaffId,
      before: null,
      after: { partialFailure: true, authUpdated: true, profileUpdateFailed: true },
      source: 'edge',
      actorId: caller.id,
    })
    return fail(
      req,
      500,
      'PARTIAL_FAILURE: the new PIN is set for sign-in but the staff record did not update, retry the reset now',
      { envelope: 'flat', detail: result.message }
    )
  }

  // A reset is how a manager unlocks a locked-out member: clear the attempt counters too.
  // Best effort: the reset itself already succeeded.
  const { error: clearError } = await supabaseAdmin.rpc('pin_attempt_clear_for_staff', { p_staff_id: targetStaffId })
  if (clearError) console.error('admin-reset-pin: attempt counters not cleared', clearError.message)

  await recordAudit(supabaseAdmin, {
    action: 'permission.admin_pin_reset',
    entityType: 'staff',
    entityId: targetStaffId,
    before: null,
    after: { mustChangePin: true }, // never log the raw newPin
    source: 'edge',
    actorId: caller.id, // unlike create-staff's null — actor is known and distinct from target here
  })

  return json(req, { id: targetProfile.id, name: targetProfile.name })
})
