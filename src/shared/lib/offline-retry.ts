/**
 * Retry policy shared by every offline replay path (the tab action queue and
 * the offline-sale queue). Lives in `shared` so entities can use it without
 * importing from `app/`.
 */

/**
 * A queued item gets this many counted dispatch attempts (across reconnects)
 * before the queue stops retrying it on its own: a tab action is moved to the
 * dead-letter queue, an offline sale goes to `needs_review`. Unreachable
 * outcomes are not counted.
 */
export const MAX_QUEUE_ATTEMPTS = 5;

/**
 * Fixed "try again soon" interval after an unreachable outcome (backend down,
 * LAN up but WAN down). Deliberately not exponential and not a counted
 * attempt: with `navigator.onLine` never flipping, nothing else would re-arm
 * the queue. The tab queue arms a pass-level timer with it; an offline sale
 * records `nextAttemptAt = now + UNREACHABLE_RETRY_MS`.
 */
export const UNREACHABLE_RETRY_MS = 30_000;

export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Exponential backoff: 2^retryCount seconds, capped at 5 minutes. */
export function computeBackoffMs(retryCount: number): number {
  return Math.min(2 ** retryCount * 1000, MAX_BACKOFF_MS);
}

/**
 * How long the replayer waits for ONE `process-direct-sale` answer before it gives up on it. A
 * hung request must not leave a sale `replaying` (which blocks every cashier's queue until a
 * restart). On timeout the sale is held, not counted, and sent again under the same idempotency
 * key, which is safe: an answer that arrives late is ignored and the server answers the re-send
 * `idempotent`.
 */
export const REPLAY_REQUEST_TIMEOUT_MS = 45_000;

/** How long the replayer waits for the auth session read; none in time counts as no session. */
export const REPLAY_SESSION_TIMEOUT_MS = 10_000;
