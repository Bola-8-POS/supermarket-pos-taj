// deno test --allow-env supabase/functions/_shared/errors_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { fail, publicRpcMessage } from './errors.ts'

function req(): Request {
  return new Request('https://example.local/fn')
}

Deno.test('publicRpcMessage: DIRECT_SALE_FAILED with an allow-listed prefix keeps the message', () => {
  const msg = publicRpcMessage('DIRECT_SALE_FAILED', 'INVENTORY_NEGATIVE: result would be -3 for ingredient X')
  assertEquals(msg, 'INVENTORY_NEGATIVE: result would be -3 for ingredient X')
})

Deno.test('publicRpcMessage: DIRECT_SALE_FAILED without an allow-listed prefix is replaced, original only logged', () => {
  const original = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => {
    logged.push(args)
  }
  try {
    const msg = publicRpcMessage('DIRECT_SALE_FAILED', 'duplicate key value violates unique constraint "orders_pkey"')
    assertEquals(msg, 'Sale could not be processed')
    assertEquals(
      logged.some((args) => args.includes('duplicate key value violates unique constraint "orders_pkey"')),
      true
    )
  } finally {
    console.error = original
  }
})

Deno.test('publicRpcMessage: CAJA_CLOSED (not a SQLERRM-carrying code) keeps the message unconditionally', () => {
  const msg = publicRpcMessage('CAJA_CLOSED', 'Caja session is not open')
  assertEquals(msg, 'Caja session is not open')
})

Deno.test('fail: nested envelope shape', async () => {
  const res = fail(req(), 403, 'FORBIDDEN', { envelope: 'nested' })
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body, { success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
})

Deno.test('fail: flat envelope body carries only the code (and extra), no message field', async () => {
  const res = fail(req(), 400, 'SAME_PIN', { envelope: 'flat' })
  const body = await res.json()
  assertEquals(body, { error: 'SAME_PIN' })
})

Deno.test('fail: ok envelope shape, with extra merged in', async () => {
  const res = fail(req(), 429, 'RATE_LIMITED', { envelope: 'ok', extra: { retryAfter: 30 } })
  const body = await res.json()
  assertEquals(body, {
    ok: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later', retryAfter: 30 },
  })
})

Deno.test('fail: nested envelope merges extra into the error object (429 shape)', async () => {
  const res = fail(req(), 429, 'RATE_LIMITED', { envelope: 'nested', extra: { retryAfter: 12 } })
  const body = await res.json()
  assertEquals(body, {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later', retryAfter: 12 },
  })
})

Deno.test('fail: opts.message overrides the default', async () => {
  const res = fail(req(), 409, 'LAST_ADMIN', { envelope: 'ok', message: 'Cannot deactivate the last admin' })
  const body = (await res.json()) as { error: { message: string } }
  assertEquals(body.error.message, 'Cannot deactivate the last admin')
})
