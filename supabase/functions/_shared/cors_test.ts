// deno test --allow-env supabase/functions/_shared/cors_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { corsHeaders } from './cors.ts'

function reqWithOrigin(origin: string | null): Request {
  const headers = new Headers()
  if (origin) headers.set('Origin', origin)
  return new Request('https://example.local/fn', { headers })
}

Deno.test('default allow-list: an allowed origin is reflected', () => {
  const headers = corsHeaders(reqWithOrigin('https://demo.bola8pos.com'))
  assertEquals(headers['Access-Control-Allow-Origin'], 'https://demo.bola8pos.com')
  assertEquals(headers['Vary'], 'Origin')
})

Deno.test('default allow-list: a disallowed origin gets no ACAO header', () => {
  const headers = corsHeaders(reqWithOrigin('https://evil.example.com'))
  assertEquals(headers['Access-Control-Allow-Origin'], undefined)
})

Deno.test('no Origin header: no ACAO header, request otherwise unaffected', () => {
  const headers = corsHeaders(reqWithOrigin(null))
  assertEquals(headers['Access-Control-Allow-Origin'], undefined)
  assertEquals(headers['Access-Control-Allow-Headers'], 'authorization, x-client-info, apikey, content-type')
})

Deno.test('loopback regex: any port on localhost/127.0.0.1 is allowed', () => {
  for (const origin of ['http://localhost:1520', 'http://127.0.0.1:1522', 'https://localhost']) {
    const headers = corsHeaders(reqWithOrigin(origin))
    assertEquals(headers['Access-Control-Allow-Origin'], origin, `expected ${origin} to be allowed`)
  }
})

Deno.test('loopback regex: does not match a lookalike host', () => {
  const headers = corsHeaders(reqWithOrigin('http://localhost.evil.com'))
  assertEquals(headers['Access-Control-Allow-Origin'], undefined)
})

Deno.test('ALLOWED_ORIGINS env replaces the default list entirely', () => {
  Deno.env.set('ALLOWED_ORIGINS', 'https://custom.example.com')
  try {
    const allowed = corsHeaders(reqWithOrigin('https://custom.example.com'))
    assertEquals(allowed['Access-Control-Allow-Origin'], 'https://custom.example.com')

    // A default-list origin is no longer allowed once ALLOWED_ORIGINS is set.
    const noLongerAllowed = corsHeaders(reqWithOrigin('https://demo.bola8pos.com'))
    assertEquals(noLongerAllowed['Access-Control-Allow-Origin'], undefined)
  } finally {
    Deno.env.delete('ALLOWED_ORIGINS')
  }
})
