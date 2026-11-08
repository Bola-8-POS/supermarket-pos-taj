// deno test --allow-env supabase/functions/_shared/upstream_test.ts
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { isUpstreamFailure, throwIfUpstream, UpstreamUnavailableError } from './upstream.ts'

Deno.test('transport and outage errors are upstream failures', () => {
  assertEquals(isUpstreamFailure({ code: '', message: 'TypeError: fetch failed' }), true)
  assertEquals(isUpstreamFailure({ message: 'connection reset' }), true)
  assertEquals(isUpstreamFailure({ code: 'UPSTREAM_UNAVAILABLE', message: 'x' }), true)
  assertEquals(isUpstreamFailure({ code: 'PGRST000', message: 'Database connection error.' }), true)
  assertEquals(isUpstreamFailure({ code: '57P01', message: 'terminating connection' }), true)
  assertEquals(isUpstreamFailure({ code: '08006', message: 'connection failure' }), true)
  assertEquals(isUpstreamFailure({ code: 'P0001', message: 'x' }, 502), true)
  assertEquals(isUpstreamFailure(null, 504), true)
})

Deno.test('business errors keep their codes', () => {
  assertEquals(isUpstreamFailure({ code: 'P0001', message: 'AMOUNT_MISMATCH: x' }), false)
  assertEquals(isUpstreamFailure({ code: '23505', message: 'duplicate key' }, 409), false)
  assertEquals(isUpstreamFailure({ code: 'PGRST116', message: 'no rows' }, 406), false)
  assertEquals(isUpstreamFailure({ code: '40001', message: 'serialization' }, 500), false)
  assertEquals(isUpstreamFailure(null, 200), false)
})

Deno.test('throwIfUpstream throws only for an upstream failure', () => {
  throwIfUpstream({ error: null }, { error: { code: 'PGRST116', message: 'no rows' } })
  assertThrows(() => throwIfUpstream({ error: null }, { error: { code: '', message: 'fetch failed' } }), UpstreamUnavailableError)
})

import { failRpcRefusalUnlessUpstream, failUnlessUpstream } from './upstream.ts'

Deno.test('failUnlessUpstream: 503 UPSTREAM_UNAVAILABLE + Retry-After for an outage, the own 500 code for a business error', async () => {
  const req = new Request('https://example.local/fn')
  const down = failUnlessUpstream(req, 'RPC_ERROR', { code: '', message: 'fetch failed' })
  assertEquals(down.status, 503)
  assertEquals(down.headers.get('Retry-After'), '5')
  assertEquals(((await down.json()) as { error: { code: string } }).error.code, 'UPSTREAM_UNAVAILABLE')
  const biz = failUnlessUpstream(req, 'RPC_ERROR', { code: 'XX000', message: 'boom' })
  assertEquals(biz.status, 500)
  assertEquals(((await biz.json()) as { error: { code: string } }).error.code, 'RPC_ERROR')
  assertEquals(failUnlessUpstream(req, 'PAYMENT_FETCH', null).status, 500)
})

Deno.test('failUnlessUpstream: a fence code quoted mid-message is not a refusal', () => {
  const req = new Request('https://example.local/fn')
  const res = failUnlessUpstream(req, 'RPC_ERROR', { code: 'P0001', message: 'INVENTORY_NEGATIVE: short of STORE_FROZEN: Chili' })
  assertEquals(res.status, 500)
})

Deno.test('failUnlessUpstream: a raised fence refusal keeps its own code and text (409), not a generic RPC_ERROR', async () => {
  const req = new Request('https://example.local/fn')
  for (const code of ['STORE_FROZEN', 'STORE_MOVED']) {
    const res = failUnlessUpstream(req, 'RPC_ERROR', { code: 'P0001', message: `${code}: stop` })
    assertEquals(res.status, 409)
    assertEquals(await res.json(), { success: false, error: { code, message: `${code}: stop` } })
  }
})

Deno.test('failRpcRefusalUnlessUpstream: listed raise prefixes are 409 with their code, everything else falls through', async () => {
  const req = new Request('https://example.local/fn')
  const refusals = ['AMOUNT_MISMATCH', 'ZERO_TOTAL_SALE']
  for (const code of refusals) {
    const r = failRpcRefusalUnlessUpstream(req, 'RPC_ERROR', { code: 'P0001', message: `${code}: nope` }, refusals)
    assertEquals(r.status, 409)
    assertEquals(((await r.json()) as { error: { code: string } }).error.code, code)
  }
  const other = failRpcRefusalUnlessUpstream(req, 'RPC_ERROR', { code: 'P0001', message: 'STOCK_CHANGED: x' }, refusals)
  assertEquals(other.status, 500)
  assertEquals(((await other.json()) as { error: { code: string } }).error.code, 'RPC_ERROR')
  assertEquals(failRpcRefusalUnlessUpstream(req, 'RPC_ERROR', { code: '', message: 'AMOUNT_MISMATCH: x' }, refusals).status, 503)
})
