// deno test --allow-env supabase/functions/_shared/caller_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.2'
import { callerHasAction, verifyCaller } from './caller.ts'

// A minimal stub of the one chain callerHasAction calls
// (.from().select().eq().eq().maybeSingle()) -- the query result is the
// only thing under test here, not the client itself.
function stubClient(result: { data: { id: string } | null; error: { message: string } | null }): SupabaseClient {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return { maybeSingle: () => Promise.resolve(result) }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

Deno.test('a matching role_permissions row returns true', async () => {
  const admin = stubClient({ data: { id: 'row-1' }, error: null })
  assertEquals(await callerHasAction(admin, 'admin', 'manage_staff'), true)
})

Deno.test('no matching row returns false', async () => {
  const admin = stubClient({ data: null, error: null })
  assertEquals(await callerHasAction(admin, 'cashier', 'manage_staff'), false)
})

Deno.test('a query error returns false', async () => {
  const admin = stubClient({ data: null, error: { message: 'connection reset' } })
  assertEquals(await callerHasAction(admin, 'admin', 'manage_staff'), false)
})

// verifyCaller: an auth-service or database outage is 503 (the till keeps the session and retries), never 401/403.
type ProfileResult = { data: { role: string; is_active: boolean } | null; error: { message: string } | null }

function profileClient(result: ProfileResult): SupabaseClient {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as unknown as SupabaseClient
}

async function withFetch<T>(stub: () => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch
  const realError = console.error
  Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1')
  Deno.env.set('SUPABASE_ANON_KEY', 'anon')
  globalThis.fetch = stub as typeof fetch
  console.error = () => {}
  try {
    return await run()
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
  }
}

const bearer = () => new Request('https://example.local/fn', { headers: { Authorization: 'Bearer t' } })
const okProfile: ProfileResult = { data: { role: 'cashier', is_active: true }, error: null }
const userOk = () => Promise.resolve(new Response(JSON.stringify({ id: 'u1' }), { status: 200 }))

Deno.test('verifyCaller: GoTrue 500 is 503 UPSTREAM_UNAVAILABLE', async () => {
  const r = await withFetch(() => Promise.resolve(new Response('{}', { status: 500 })), () => verifyCaller(bearer(), profileClient(okProfile)))
  assertEquals(r, { ok: false, status: 503, error: 'UPSTREAM_UNAVAILABLE' })
})

Deno.test('verifyCaller: a thrown fetch is 503', async () => {
  const r = await withFetch(() => Promise.reject(new TypeError('connection refused')), () => verifyCaller(bearer(), profileClient(okProfile)))
  assertEquals(r, { ok: false, status: 503, error: 'UPSTREAM_UNAVAILABLE' })
})

Deno.test('verifyCaller: GoTrue 401 and 403 stay 401', async () => {
  for (const status of [401, 403]) {
    const r = await withFetch(() => Promise.resolve(new Response('{}', { status })), () => verifyCaller(bearer(), profileClient(okProfile)))
    assertEquals(r, { ok: false, status: 401, error: 'Invalid session' })
  }
})

Deno.test('verifyCaller: a failed profile lookup is 503, an inactive or missing profile is still 403', async () => {
  const failed = await withFetch(userOk, () => verifyCaller(bearer(), profileClient({ data: null, error: { message: 'fetch failed' } })))
  assertEquals(failed, { ok: false, status: 503, error: 'UPSTREAM_UNAVAILABLE' })
  const inactive = await withFetch(userOk, () => verifyCaller(bearer(), profileClient({ data: { role: 'cashier', is_active: false }, error: null })))
  assertEquals(inactive.ok === false && inactive.status, 403)
  const missing = await withFetch(userOk, () => verifyCaller(bearer(), profileClient({ data: null, error: null })))
  assertEquals(missing.ok === false && missing.status, 403)
})

Deno.test('verifyCaller: a missing bearer is 401 and a healthy caller passes', async () => {
  const none = await verifyCaller(new Request('https://example.local/fn'), profileClient(okProfile))
  assertEquals(none, { ok: false, status: 401, error: 'Missing bearer token' })
  const ok = await withFetch(userOk, () => verifyCaller(bearer(), profileClient(okProfile)))
  assertEquals(ok, { ok: true, id: 'u1', role: 'cashier' })
})
