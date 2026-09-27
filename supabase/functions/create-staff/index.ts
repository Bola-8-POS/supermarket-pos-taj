// Deno runtime
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { z } from 'https://deno.land/x/zod@v3.23.8/mod.ts'
import { recordAudit } from '../_shared/audit.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { fail } from '../_shared/errors.ts'

const BodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  pin: z.string().regex(/^\d{6}$/),
  role: z.enum(['cashier', 'manager', 'admin', 'kitchen']),
  locale: z.enum(['es-MX', 'en-US']).optional(),
})

function methodsHeader(req: Request): Record<string, string> {
  return { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: methodsHeader(req) })
  if (req.method !== 'POST') return fail(req, 405, 'METHOD_NOT_ALLOWED', { envelope: 'flat' })

  // Bearer-JWT verification via a direct HTTP call to /auth/v1/user.
  // admin.auth.getUser() fails on ES256-signed tokens ("Unsupported JWT
  // algorithm ES256") in this supabase-js version — the Auth REST API
  // handles ES256 correctly. Same pattern as process-payment/index.ts.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return fail(req, 401, 'UNAUTHORIZED', { envelope: 'flat' })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const authVerifyResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: authHeader,
      apikey: supabaseAnonKey,
    },
  })

  if (!authVerifyResp.ok) {
    return fail(req, 401, 'UNAUTHORIZED', { envelope: 'flat' })
  }

  const authUser = (await authVerifyResp.json()) as { id: string }

  // Single admin client, reused for the role lookup below and the
  // createUser/insert calls further down — don't construct two.
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const { data: callerProfile, error: callerProfileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', authUser.id)
    .single()

  if (callerProfileError || !callerProfile || !['admin', 'manager'].includes(callerProfile.role)) {
    return fail(req, 403, 'FORBIDDEN', { envelope: 'flat' })
  }

  let bodyJson: unknown
  try {
    bodyJson = await req.json()
  } catch {
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'flat' })
  }

  const parsed = BodySchema.safeParse(bodyJson)
  if (!parsed.success) {
    return fail(req, 400, 'VALIDATION_ERROR', { envelope: 'flat' })
  }

  const { name, role, pin, locale } = parsed.data

  // manage_staff (the RBAC action gating the "Add Staff" UI) is admin-only —
  // a manager caller must not be able to mint an admin/manager account by
  // calling this endpoint directly, bypassing the client-side RBAC boundary.
  if (['admin', 'manager'].includes(role) && callerProfile.role !== 'admin') {
    return fail(req, 403, 'FORBIDDEN', { envelope: 'flat' })
  }

  const staffId = crypto.randomUUID()
  const email = `${staffId}@barpos.local`

  const { error: authError } = await supabaseAdmin.auth.admin.createUser({
    id: staffId,
    email,
    password: pin,
    email_confirm: true,
    user_metadata: { name, role },
  })

  if (authError) {
    return fail(req, 400, 'AUTH_WRITE_FAILED', { envelope: 'flat', detail: authError.message })
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({
      id: staffId,
      name,
      role,
      pin,
      email,
      is_active: true,
      must_change_pin: true,
      ...(locale ? { locale } : {}),
    })

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(staffId)
    return fail(req, 400, 'PROFILE_WRITE_FAILED', { envelope: 'flat', detail: profileError.message })
  }

  await recordAudit(supabaseAdmin, {
    action: 'staff.create',
    entityType: 'staff',
    entityId: staffId,
    before: null,
    after: { name, role, email },
    source: 'edge',
    actorId: null,
  })

  return new Response(JSON.stringify({ id: staffId, email, name, role }), {
    headers: { 'Content-Type': 'application/json', ...methodsHeader(req) },
  })
})
