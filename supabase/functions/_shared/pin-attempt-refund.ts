// Gives counted PIN attempts back when a request failed without evaluating the PIN (see
// 20261002000002_pin_attempt_refund.sql). Best effort and never throws: the 503 the caller is
// about to return matters more than the refund.

/**
 * True when an Auth sign-in error is a service fault, not a wrong PIN: any non-400 answer, or a 400
 * whose message is HOOK_REJECTED (the Offline-only auth-server password hook refusing before it
 * evaluated the PIN, Plan 04b). HOOK_ERROR is deliberately NOT refunded: a fault on only the
 * wrong-PIN path would refund every wrong guess while the right PIN still succeeds (fail-closed).
 * Hosted Supabase never sends HOOK_REJECTED, so there the second condition is inert. A `LOCKED:<n>`
 * 400, HOOK_ERROR and a plain wrong-password 400 are credential failures and stay counted.
 * HOOK_ERROR and LOCKED:<n> stay counted whatever their HTTP status (GoTrue defaults a hook error to 500).
 */
export function isAuthServiceFault(error: { status?: number | undefined; message: string }): boolean {
  if (error.message === 'HOOK_ERROR' || /^LOCKED:\d+$/.test(error.message)) return false
  return error.status !== 400 || error.message === 'HOOK_REJECTED'
}

export async function refundPinAttempts(
  refund: (key: string) => PromiseLike<{ error: { message: string } | null }>,
  keys: string[],
): Promise<void> {
  const results = await Promise.allSettled(keys.map((key) => Promise.resolve().then(() => refund(key))))
  for (const result of results) {
    if (result.status === 'rejected') console.error('pin attempt refund failed', String(result.reason))
    else if (result.value.error) console.error('pin attempt refund failed', result.value.error.message)
  }
}
