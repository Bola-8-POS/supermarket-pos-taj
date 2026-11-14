// Change the signed-in staff member's own PIN (the forced first-login change).
// Both credential stores are written in one server-side operation (profile
// first, Auth second, profile restored on an Auth failure), see
// _shared/credentials.ts.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'
import { recordAudit } from '../_shared/audit.ts'
import { verifyCaller } from '../_shared/caller.ts'
import { writeCredential } from '../_shared/credentials.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { fail } from '../_shared/errors.ts'
import { deriveStaffPassword, staffPasswordPepper } from '../_shared/staff-password.ts'

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
  // profiles.pin is a bcrypt hash: the comparison happens in the database.
  const { data: holders, error: holdersError } = await admin.rpc('staff_ids_with_pin', { p_pin: newPin })
  if (holdersError) {
    console.error('change-own-pin: same-PIN check failed', holdersError.message)
    return fail(req, 500, 'INTERNAL', { envelope: 'flat' })
  }
  if ((holders ?? []).includes(caller.id)) return fail(req, 400, 'SAME_PIN', { envelope: 'flat' })

  const pepper = staffPasswordPepper()
  if (!pepper) return fail(req, 500, 'CONFIG', { envelope: 'flat', detail: 'STAFF_PASSWORD_PEPPER is not configured' })

  // The Auth password is written with the caller's own token (PUT
  // /auth/v1/user): a self update keeps the current session, while an admin
  // update would end every session of the user, including the one making
  // this call. The same token is what the restore step relies on.
  const setPassword = async (_id: string, pin: string) => {
    let password: string
    try {
      password = await deriveStaffPassword(caller.id, pin, pepper)
    } catch (e) {
      return { error: { message: (e as Error).message } }
    }
    let resp: Response
    try {
      resp = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          Authorization: req.headers.get('Authorization')!,
          apikey: Deno.env.get('SUPABASE_ANON_KEY')!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      })
    } catch (e) {
      return { error: { message: (e as Error).message } }
    }
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
      profileHolds: async (id, patch) => {
        const { data: row } = await admin.from('profiles').select('pin, must_change_pin').eq('id', id).single()
        if (!row || row.must_change_pin !== patch.must_change_pin) return false
        // A verbatim restore carries a stored hash; a new PIN is compared in the database.
        if (typeof patch.pin === 'string' && patch.pin.startsWith('$2')) return row.pin === patch.pin
        const { data: holders } = await admin.rpc('staff_ids_with_pin', { p_pin: patch.pin as string })
        return (holders ?? []).includes(id)
      },
    },
    {
      userId: caller.id,
      newPin,
      profilePatch: { pin: newPin, must_change_pin: false },
      previousProfile: { pin: profile.pin, must_change_pin: profile.must_change_pin },
    }
  )

  if (!result.ok) {
    if (result.code === 'COMPENSATED') {
      await recordAudit(admin, {
        action: 'permission.force_pin_change',
        entityType: 'staff',
        entityId: caller.id,
        before: null,
        after: { failed: true, compensated: true },
        source: 'edge',
        actorId: caller.id,
        terminalId,
      })
      return fail(req, 409, 'CREDENTIAL_WRITE_FAILED: nothing changed, try again', { envelope: 'flat' })
    }
    await recordAudit(admin, {
      action: 'permission.force_pin_change',
      entityType: 'staff',
      entityId: caller.id,
      before: null,
      after: { partialFailure: true, profileUpdated: true, authUpdateFailed: true, restoreFailed: true },
      source: 'edge',
      actorId: caller.id,
      terminalId,
    })
    return fail(
      req,
      500,
      'PARTIAL_FAILURE: credential changed but sign-in record failed to sync, contact support',
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
