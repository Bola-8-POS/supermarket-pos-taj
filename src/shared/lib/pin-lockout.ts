/**
 * The PIN attempt lockout schedule: four free attempts, then 30 s doubling
 * per further failure up to 15 minutes, starting over after 30 minutes
 * without an attempt.
 *
 * The server enforces the same schedule in SQL — `pin_attempt_begin` and
 * `pin_attempt_record` in
 * `supabase/migrations/20260921000003_staff_directory_and_pin_checks.sql`.
 * Change both together; the offline checks on this side must never be
 * looser than the server's.
 */
export const PIN_LOCKOUT = {
  freeAttempts: 4,
  baseDelayMs: 30_000,
  maxDelayMs: 900_000,
  idleResetMs: 1_800_000,
} as const;

/** Wait imposed after `failedAttempts` consecutive failures (0 while free). */
export function nextRetryAfterMs(failedAttempts: number): number {
  if (failedAttempts <= PIN_LOCKOUT.freeAttempts) return 0;
  const doublings = Math.min(failedAttempts - PIN_LOCKOUT.freeAttempts - 1, 5);
  return Math.min(PIN_LOCKOUT.maxDelayMs, PIN_LOCKOUT.baseDelayMs * 2 ** doublings);
}

/** True when the last attempt is old enough that the failure count starts over. */
export function isIdleReset(lastAttemptAt: number, now: number): boolean {
  return now - lastAttemptAt > PIN_LOCKOUT.idleResetMs;
}
