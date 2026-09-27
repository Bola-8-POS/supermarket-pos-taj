// Verifies the signed-in caller of an edge function and loads its profile.
//
// The bearer token is checked with a direct call to GET /auth/v1/user:
// admin.auth.getUser() rejects ES256-signed tokens ("Unsupported JWT
// algorithm ES256") in this supabase-js version, the Auth REST API handles
// them. Role decisions stay in each function; this only refuses a missing or
// invalid session and an inactive or missing profile.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
