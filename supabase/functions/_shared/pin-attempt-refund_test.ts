// deno test --allow-env supabase/functions/_shared/pin-attempt-refund_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { isAuthServiceFault, refundPinAttempts } from './pin-attempt-refund.ts'

Deno.test('classifies Auth errors: service faults refund, credential failures stay counted', () => {
  // Service faults: a non-400 answer, no status at all, and the Offline hook's HOOK_REJECTED (the
  // hook refused the request before evaluating the PIN). HOOK_ERROR stays counted (fail-closed): a
  // fault on only the wrong-PIN path would otherwise refund every wrong guess while the right PIN succeeds.
  assertEquals(isAuthServiceFault({ status: 500, message: 'down' }), true)
  assertEquals(isAuthServiceFault({ status: 429, message: 'rate limit' }), true)
  assertEquals(isAuthServiceFault({ message: 'network' }), true)
  assertEquals(isAuthServiceFault({ status: 400, message: 'HOOK_REJECTED' }), true)
  assertEquals(isAuthServiceFault({ status: 400, message: 'HOOK_ERROR' }), false) // counted, fail-closed
  // Credential failures: a plain wrong password, the hook's LOCKED:<n> verdict, and near-misses.
  assertEquals(isAuthServiceFault({ status: 400, message: 'Invalid login credentials' }), false)
  assertEquals(isAuthServiceFault({ status: 400, message: 'LOCKED:30' }), false)
  assertEquals(isAuthServiceFault({ status: 400, message: 'HOOK_ERROR_EXTRA' }), false)
  assertEquals(isAuthServiceFault({ status: 400, message: 'xHOOK_ERROR' }), false)
  // The hook's verdicts stay counted whatever HTTP status GoTrue gives them (it defaults to 500).
  assertEquals(isAuthServiceFault({ status: 500, message: 'HOOK_ERROR' }), false)
  assertEquals(isAuthServiceFault({ status: 429, message: 'LOCKED:30' }), false)
})

Deno.test('refunds every key it is given', async () => {
  const seen: string[] = []
  await refundPinAttempts(
    (key) => {
      seen.push(key)
      return Promise.resolve({ error: null })
    },
    ['login:a', 'login:a:addr'],
  )
  assertEquals(seen.sort(), ['login:a', 'login:a:addr'])
})

Deno.test('a failing or throwing refund is logged and never thrown', async () => {
  await refundPinAttempts(() => Promise.resolve({ error: { message: 'boom' } }), ['login:a'])
  await refundPinAttempts(() => Promise.reject(new Error('network')), ['login:a'])
  await refundPinAttempts(() => {
    throw new Error('sync')
  }, ['login:a'])
})

Deno.test('with no keys it makes no call', async () => {
  let calls = 0
  await refundPinAttempts(() => {
    calls += 1
    return Promise.resolve({ error: null })
  }, [])
  assertEquals(calls, 0)
})
