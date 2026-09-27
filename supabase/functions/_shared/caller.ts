// Verifies the signed-in caller of an edge function and loads its profile.
//
// The bearer token is checked with a direct call to GET /auth/v1/user
// rather than the SDK's getClaims()/getUser(): one REST call is
// algorithm-agnostic (the same code path whether the project signs HS256
// or ES256 tokens) and is proven on the hosted project. getClaims() (added
// in auth-js@2.69.0, bundled by this pin) would add a JWKS fetch path whose
// failure modes on this self-hosted stack are unmeasured; adopting it is
// not planned. Role decisions stay in each function; this only refuses a
// missing or invalid session and an inactive or missing profile.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2'

export type CallerResult =
  | { ok: true; id: string; role: string }
  | { ok: false; status: 401 | 403; error: string }

export async function verifyCaller(req: Request, admin: SupabaseClient): Promise<CallerResult> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing bearer token' }
  }

  const resp = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
  })
  if (!resp.ok) return { ok: false, status: 401, error: 'Invalid session' }
  const user = (await resp.json()) as { id: string }

  const { data: profile, error } = await admin
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .maybeSingle()
  if (error || !profile?.is_active) {
    console.error(
      'verifyCaller: profile refused',
      user.id,
      error?.message ?? (profile ? 'profile inactive' : 'no profile row')
    )
    return { ok: false, status: 403, error: 'Insufficient role' }
  }

  return { ok: true, id: user.id, role: profile.role as string }
}

/**
 * Looks up whether `role` holds `action` in role_permissions -- one REST
 * call through the admin client's PostgREST query, no SDK-level JWT
 * verification and no ES256 story (that is verifyCaller's concern above,
 * not this lookup's). Lifted out of set-staff-active, which already ran
 * this exact query inline; every conversion from a hard-coded role literal
 * to a role_permissions action uses this instead of re-implementing the
 * lookup.
 */
export async function callerHasAction(admin: SupabaseClient, role: string, action: string): Promise<boolean> {
  const { data, error } = await admin
    .from('role_permissions')
    .select('id')
    .eq('role', role)
    .eq('action', action)
    .maybeSingle()
  if (error) {
    console.error('callerHasAction: lookup failed', role, action, error.message)
    return false
  }
  return data !== null
}
