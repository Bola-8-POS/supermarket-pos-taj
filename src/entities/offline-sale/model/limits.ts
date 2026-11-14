import { MAX_QUEUE_ATTEMPTS } from '@shared/lib/offline-retry';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';

const HOUR_MS = 3_600_000;

/** Owner-tunable (two-mode Plan 02b, Ruling 16; owner decision D4: 500 records / 24 h). 500 records fit in localStorage - see limits.test.ts. */
export const OFFLINE_SALE_LIMITS = {
  maxNonTerminal: 500,
  maxOldestAgeMs: 24 * HOUR_MS,
  maxAttempts: MAX_QUEUE_ATTEMPTS,
  confirmedRetentionMs: 48 * HOUR_MS,
  /** Re-ring attempt keys kept on one record, newest last (D13); about 38 bytes each. */
  maxReRingAttemptKeys: 20,
} as const;

/** True for statuses that still need work (everything but confirmed / resolved). */
export const isNonTerminal = (sale: OfflineSale): boolean =>
  sale.status !== 'confirmed' && sale.status !== 'resolved';

export function checkOfflineSaleLimits(
  records: readonly OfflineSale[],
  now: number
): { ok: true } | { ok: false; reason: 'count' | 'age' } {
  const open = records.filter(isNonTerminal);
  if (open.length >= OFFLINE_SALE_LIMITS.maxNonTerminal) return { ok: false, reason: 'count' };
  const oldest = Math.min(...open.map(r => Date.parse(r.soldAt)));
  if (open.length > 0 && now - oldest >= OFFLINE_SALE_LIMITS.maxOldestAgeMs) {
    return { ok: false, reason: 'age' };
  }
  return { ok: true };
}
