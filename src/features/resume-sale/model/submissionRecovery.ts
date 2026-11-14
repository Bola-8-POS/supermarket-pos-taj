import type { PaymentLookup } from '@entities/payment';
import type { Result } from '@shared/lib/result';

/**
 * Longest time the server can still commit a sale after the client gave up on it.
 * 30-03-PROBE.md SUBMISSION_SETTLE_MS_CONFIRMED: VERIFIED against the hosted edge-function wall clock
 * (400 s paid plan); no client timeout and no function timeout shorten it.
 */
export const SUBMISSION_SETTLE_MS = 400_000;
export const SUBMISSION_RECHECK_MS = 5000;

export type RecoveryView =
  | { kind: 'checking' }
  | { kind: 'completed'; paymentId: string; tabId: string }
  | { kind: 'reconciling' }
  | { kind: 'incomplete' }
  | { kind: 'unknown' };

/**
 * Pure function of the lookup and the clock. "Not found" only means "not charged" once the settle window has
 * passed. The window is measured from min(startedAt, firstSeenAt): a persisted startedAt in the future or a
 * clock rolled back can only lengthen the wait. A lookup error is never "not charged".
 */
export function classifySubmissionRecovery(input: {
  lookup: Result<PaymentLookup> | 'pending';
  startedAt: number;
  firstSeenAt: number;
  now: number;
}): RecoveryView {
  const { lookup, startedAt, firstSeenAt, now } = input;
  if (lookup === 'pending') return { kind: 'checking' };
  if (!lookup.ok) return { kind: 'unknown' };
  if (lookup.data.status === 'completed') {
    return { kind: 'completed', paymentId: lookup.data.paymentId, tabId: lookup.data.tabId };
  }
  return now - Math.min(startedAt, firstSeenAt) >= SUBMISSION_SETTLE_MS ? { kind: 'incomplete' } : { kind: 'reconciling' };
}
