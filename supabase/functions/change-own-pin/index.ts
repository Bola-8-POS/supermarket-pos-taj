// Change the signed-in staff member's own PIN (the forced first-login change).
// Both credential stores are written in one server-side operation with
// compensation, see _shared/credentials.ts.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'
import { recordAudit } from '../_shared/audit.ts'
import { verifyCaller } from '../_shared/caller.ts'
import { writeCredential } from '../_shared/credentials.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { fail } from '../_shared/errors.ts'

const BodySchema = z.object({
  newPin: z.string().regex(/^\d{6}$/),
  terminalId: z.string().optional(),
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

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const caller = await verifyCaller(req, admin)
  if (!caller.ok) return fail(req, caller.status, caller.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', { envelope: 'flat' })

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'flat' })
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'flat' })
  const { newPin, terminalId } = parsed.data

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('pin, must_change_pin')
    .eq('id', caller.id)
    .single()
  if (profileError || !profile) {
    console.error('change-own-pin: own profile lookup failed', caller.id, profileError?.message ?? 'no row')
    return fail(req, 403, 'FORBIDDEN', { envelope: 'flat' })
  }
  if (newPin === profile.pin) return fail(req, 400, 'SAME_PIN', { envelope: 'flat' })

  // The Auth password is written with the caller's own token (PUT
  // /auth/v1/user): a self update keeps the current session, while an admin
  // update would end every session of the user, including the one making
  // this call. The same token is what the restore step relies on.
  const setPassword = async (_id: string, pin: string) => {
    const resp = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        Authorization: req.headers.get('Authorization')!,
        apikey: Deno.env.get('SUPABASE_ANON_KEY')!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: pin }),
    })
    if (resp.ok) return { error: null }
    const body = (await resp.json().catch(() => ({}))) as { error_code?: string; msg?: string; message?: string }
    // GoTrue refuses a self update to the password already in place
    // (422, error_code same_password). The Auth store then already holds the
    // requested value, which is what a retry after a partial failure looks
    // like: count it as written so the profile write can bring both stores
    // back together. The admin endpoint has no such check.
    if (resp.status === 422 && body.error_code === 'same_password') return { error: null }
    return { error: { message: body.msg ?? body.message ?? `auth update failed (${resp.status})` } }
  }

  const result = await writeCredential(
    {
      setPassword,
      updateProfile: async (id, patch) => await admin.from('profiles').update(patch).eq('id', id),
    },
    {
      userId: caller.id,
      previousPin: profile.pin,
      newPin,
      profilePatch: { pin: newPin, must_change_pin: false },
    }
  )

  if (!result.ok) {
    if (result.code === 'AUTH_WRITE_FAILED') {
      return fail(req, 400, 'AUTH_WRITE_FAILED', { envelope: 'flat', detail: result.message })
    }
    if (result.code === 'COMPENSATED') {
      return fail(req, 409, 'CREDENTIAL_WRITE_FAILED: nothing changed, try again', { envelope: 'flat' })
    }
    await recordAudit(admin, {
      action: 'permission.force_pin_change',
      entityType: 'staff',
      entityId: caller.id,
      before: null,
      after: { partialFailure: true, authUpdateSucceeded: true, profileUpdateFailed: true },
      source: 'edge',
      actorId: caller.id,
      terminalId,
    })
    return fail(
      req,
      500,
      'PARTIAL_FAILURE: credential changed but staff record failed to sync, contact support',
      { envelope: 'flat', detail: result.message }
    )
  }

  // Same action name clear_must_change_pin records; never the PIN itself.
  await recordAudit(admin, {
    action: 'permission.force_pin_change',
    entityType: 'staff',
    entityId: caller.id,
    before: { must_change_pin: profile.must_change_pin },
    after: { must_change_pin: false },
    source: 'edge',
    actorId: caller.id,
    terminalId,
  })

  return json(req, { ok: true })
})
