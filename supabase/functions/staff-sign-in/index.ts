// Staff sign-in: exchanges a staff id and PIN for a session.
// The caller sends no user token (nobody is signed in yet); the function
// looks the account up with the service role and signs in on the caller's
// behalf, with attempt limiting shared with the in-app PIN checks (Task 2's
// pin_attempt_begin, pin_attempt_retry_after and pin_attempt_record).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'
import { corsHeaders } from '../_shared/cors.ts'

const BodySchema = z.object({
  staffId: z.string().uuid(),
  pin: z.string().regex(/^\d{6}$/),
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
  if (req.method !== 'POST') return json(req, { error: 'INVALID_REQUEST' }, 405)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return json(req, { error: 'INVALID_REQUEST' }, 400)
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) return json(req, { error: 'INVALID_REQUEST' }, 400)
  const { staffId, pin } = parsed.data

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const noSession = { auth: { persistSession: false, autoRefreshToken: false } }
  const admin = createClient(supabaseUrl, serviceRoleKey, noSession)

  // The last entry is the one the gateway appended; earlier entries are
  // caller-supplied.
  const address = (req.headers.get('x-forwarded-for') ?? '').split(',').pop()?.trim() || 'unknown'

  // Two keys: the account key caps how many wrong PINs a staff member's
  // sign-in accepts regardless of caller address (a caller-chosen address
  // cannot buy a fresh key); the address key caps how many wrong PINs one
  // network address may send (a shared store address cannot lock one staff
  // member out for longer than the account key's own cap).
  const accountKey = `login:${staffId}`
  const addressKey = `login:${staffId}:${address}`

  // Serialized per key: counts this attempt up front (returns 0) or refuses
  // it outright when already locked (returns the seconds still locked,
  // without counting it again). This is what keeps a parallel burst from
  // exceeding the attempt budget. Both keys are opened (and so both count
  // this attempt) even when one is already locked.
  const { data: beganAccount, error: beginAccountError } = await admin.rpc('pin_attempt_begin', {
    p_key: accountKey,
  })
  if (beginAccountError) {
    console.error('staff-sign-in: attempt lookup failed', beginAccountError.message)
    return json(req, { error: 'UNAVAILABLE' }, 503)
  }
  const { data: beganAddress, error: beginAddressError } = await admin.rpc('pin_attempt_begin', {
    p_key: addressKey,
  })
  if (beginAddressError) {
    console.error('staff-sign-in: attempt lookup failed', beginAddressError.message)
    return json(req, { error: 'UNAVAILABLE' }, 503)
  }
  const waitAccount = typeof beganAccount === 'number' ? beganAccount : 0
  const waitAddress = typeof beganAddress === 'number' ? beganAddress : 0
  if (waitAccount > 0 || waitAddress > 0) {
    return json(req, { error: 'LOCKED', retryAfter: Math.max(waitAccount, waitAddress) }, 429)
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('email, is_active, must_change_pin')
    .eq('id', staffId)
    .maybeSingle()
  if (profileError) {
    console.error('staff-sign-in: profile lookup failed', profileError.message)
    return json(req, { error: 'UNAVAILABLE' }, 503)
  }

  let session: { access_token: string; refresh_token: string } | null = null
  if (profile?.is_active && profile.email) {
    const signedOut = createClient(supabaseUrl, anonKey, noSession)
    const { data, error } = await signedOut.auth.signInWithPassword({ email: profile.email, password: pin })
    if (error && error.status !== 400) {
      // Not a credential failure (rate limit, outage). The attempt stays counted.
      console.error('staff-sign-in: auth service error', error.status)
      return json(req, { error: 'UNAVAILABLE' }, 503)
    }
    session = data.session
    // The session must belong to the requested staff member.
    if (data.user?.id !== staffId) session = null
  }

  if (!session) {
    // The attempt was already counted by pin_attempt_begin above; read the
    // lock now in force instead of recording a second failure.
    const [{ data: waitAcc }, { data: waitAddr }] = await Promise.all([
      admin.rpc('pin_attempt_retry_after', { p_key: accountKey }),
      admin.rpc('pin_attempt_retry_after', { p_key: addressKey }),
    ])
    const retryAfter = Math.max(typeof waitAcc === 'number' ? waitAcc : 0, typeof waitAddr === 'number' ? waitAddr : 0)
    return json(req, { error: 'INVALID_CREDENTIALS', retryAfter }, 401)
  }

  const [{ error: resetAccountError }, { error: resetAddressError }] = await Promise.all([
    admin.rpc('pin_attempt_record', { p_key: accountKey, p_success: true }),
    admin.rpc('pin_attempt_record', { p_key: addressKey, p_success: true }),
  ])
  if (resetAccountError || resetAddressError) {
    console.error('staff-sign-in: attempt reset failed', (resetAccountError ?? resetAddressError)?.message)
  }
  return json(req, {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    mustChangePin: profile?.must_change_pin === true,
  })
})
