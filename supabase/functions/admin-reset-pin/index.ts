// Deno runtime
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'
import { recordAudit } from '../_shared/audit.ts'
import { verifyCaller } from '../_shared/caller.ts'
import { writeCredential } from '../_shared/credentials.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { fail } from '../_shared/errors.ts'

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

  // D-01: single-stage, admin-only gate — stricter than create-staff's
  // ['admin','manager'] gate, deliberately, since this is a live-credential
  // overwrite on an existing account, not account creation.
  if (caller.role !== 'admin') return fail(req, 403, 'FORBIDDEN', { envelope: 'flat' })

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
    .select('id, name, is_active, pin')
    .eq('id', targetStaffId)
    .single()

  if (targetLookupError || !targetProfile) return fail(req, 404, 'NOT_FOUND', { envelope: 'flat' })
  if (!targetProfile.is_active) return fail(req, 400, 'INACTIVE', { envelope: 'flat' })

  // Both credential stores in one operation: Auth first, then the profile;
  // the previous Auth password is restored when the profile write fails.
  const result = await writeCredential(
    {
      setPassword: (id, pin) => supabaseAdmin.auth.admin.updateUserById(id, { password: pin }),
      updateProfile: async (id, patch) => await supabaseAdmin.from('profiles').update(patch).eq('id', id),
    },
    {
      userId: targetStaffId,
      previousPin: targetProfile.pin,
      newPin,
      profilePatch: { pin: newPin, must_change_pin: true },
    }
  )

  if (!result.ok) {
    if (result.code === 'AUTH_WRITE_FAILED') {
      return fail(req, 400, 'AUTH_WRITE_FAILED', { envelope: 'flat', detail: result.message })
    }
    if (result.code === 'COMPENSATED') {
      return fail(req, 409, 'CREDENTIAL_WRITE_FAILED: nothing changed, try again', { envelope: 'flat' })
    }
    // The two credential stores diverged and the restore did not land:
    // surface a distinct, loud error and record the divergence.
    await recordAudit(supabaseAdmin, {
      action: 'permission.admin_pin_reset',
      entityType: 'staff',
      entityId: targetStaffId,
      before: null,
      after: { partialFailure: true, authUpdateSucceeded: true, profileUpdateFailed: true },
      source: 'edge',
      actorId: caller.id,
    })
    return fail(
      req,
      500,
      'PARTIAL_FAILURE: credential changed but staff record failed to sync — contact support before this staff member logs in',
      { envelope: 'flat', detail: result.message }
    )
  }

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
