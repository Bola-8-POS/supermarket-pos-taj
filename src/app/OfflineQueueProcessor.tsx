import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useStaffStore } from '@entities/staff/model/store';
import { useMutationOpenTab } from '@entities/tab/model/queries';
import { useMutationAddOrder } from '@entities/tab/model/queries';
import { useTabStore, type OfflineAction } from '@entities/tab/model/store';
import { isUnreachableFailure, useOnlineStatus } from '@shared/lib/connectivity';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { MAX_QUEUE_ATTEMPTS, UNREACHABLE_RETRY_MS } from '@shared/lib/offline-retry';
import { formatDiscardedSummary } from '@shared/lib/offline-summary';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';

const ENTITY_BY_ACTION_TYPE: Record<OfflineAction['type'], string> = {
  'open-tab': 'tabs',
  'place-order': 'tabs',
  'start-pool-timer': 'pool_sessions',
  'stop-pool-timer': 'pool_sessions',
};

export { MAX_QUEUE_ATTEMPTS, UNREACHABLE_RETRY_MS };

/**
 * Fix round 1 (code review): deterministic business-rule rejections that a
 * 'place-order' replay's RPC chain (create_order_with_items ->
 * deplete_for_order_item -> consume_open_unit, the only currently-retried
 * path) can raise via a plain `RAISE EXCEPTION 'CODE: ...'` with no custom
 * SQLSTATE — AUTH_FORBIDDEN (role guard, deplete_for_order_item),
 * VALIDATION_ERROR (misconfigured parent product / iteration guard,
 * consume_open_unit) and INVENTORY_NEGATIVE (no unopened package left,
 * consume_open_unit). None of these get a custom SQLSTATE, so
 * parseSupabaseError (src/shared/lib/result.ts) falls through to the
 * generic 'SUPABASE_ERROR' code — indistinguishable from a network blip by
 * code alone — but Postgres preserves the raised message verbatim, so the
 * prefix is what identifies a failure that will happen identically on every
 * retry and must be discarded immediately instead of retried (controller
 * ruling (b)). See the retry-safety audit in task-7-report.md ("Fix round
 * 1") for the full RPC audit and any action types this could not classify.
 */
const BUSINESS_REJECTION_PREFIXES = ['AUTH_FORBIDDEN:', 'VALIDATION_ERROR:', 'INVENTORY_NEGATIVE:'];

/**
 * True when a replay failure is a deterministic business-rule rejection —
 * it will fail the exact same way on every retry — rather than a
 * transient/unknown failure worth retrying. Prefers the parsed AppErrorCode
 * when parseSupabaseError already exposes one for this rejection (e.g.
 * AUTH_FORBIDDEN via an RLS 42501, VALIDATION_ERROR via a 23514 check
 * constraint); falls back to the message prefix for the RPCs above, which
 * raise the same rejections with no custom SQLSTATE and therefore always
 * surface as the generic 'SUPABASE_ERROR' code.
 */
function isBusinessRejection(code: string, message: string): boolean {
  if (code === 'AUTH_FORBIDDEN' || code === 'VALIDATION_ERROR') return true;
  return BUSINESS_REJECTION_PREFIXES.some(prefix => message.startsWith(prefix));
}

function payloadEntityId(action: OfflineAction): string | null {
  const p = action.payload;
  if (p == null || typeof p !== 'object') return null;
  const obj = p as Record<string, unknown>;
  if (typeof obj['tabId'] === 'string') return obj['tabId'];
  if (typeof obj['sessionId'] === 'string') return obj['sessionId'];
  if (typeof obj['tableId'] === 'string') return obj['tableId'];
  return null;
}

/**
 * I2 (partial): the staff member who performed the queued action, so a
 * dead-letter audit row identifies who to follow up with. `place-order`
 * carries it nested under `order.staffId`; `open-tab` carries it directly.
 */
function payloadStaffId(action: OfflineAction): string | null {
  const p = action.payload;
  if (p == null || typeof p !== 'object') return null;
  const obj = p as Record<string, unknown>;
  if (typeof obj['staffId'] === 'string') return obj['staffId'];
  const order = obj['order'];
  if (order != null && typeof order === 'object') {
    const staffId = (order as Record<string, unknown>)['staffId'];
    if (typeof staffId === 'string') return staffId;
  }
  return null;
}

function writeDiscardAuditAsync(action: OfflineAction, auditAction: string): void {
  void Promise.resolve()
    .then(async () => {
      const res = await supabase.rpc('record_audit', {
        p_action: auditAction,
        p_entity_type: ENTITY_BY_ACTION_TYPE[action.type],
        p_entity_id: payloadEntityId(action),
        // I2 (partial): a dead-lettered action's payload is the only record of
        // what was lost (tab, items, quantities) once it's out of the queue —
        // include it, plus the acting staff id, so /audit can identify both.
        p_before: {
          expectedVersion: action.expectedVersion,
          action_type: action.type,
          payload: action.payload,
        },
        p_after: null,
        p_terminal_id: getTerminalId(),
        p_user_id: payloadStaffId(action),
      } as never);
      if (res.error) {
        logger.warn('offline.queue.replay.audit_failed', {
          actionId: action.id,
          message: res.error.message,
        });
      }
    })
    .catch((e: unknown) => {
      logger.warn('offline.queue.replay.audit_threw', { actionId: action.id, error: e });
    });
}

/**
 * Headless component that replays the offline action queue when connectivity
 * returns. Must be rendered inside <QueryClientProvider>.
 *
 * A replay pass is triggered three ways (offline-first Plan 01 Task 7, I1),
 * all gated on being "ready" — online AND signed in (re-review, N-I2): a
 * transition into ready, a mount while already ready (so a persisted queue
 * from a prior session isn't stranded until the next transition), and a
 * timer armed for the earliest queued `nextAttemptAt` (so backoff fires on
 * its own, not only on reconnect). Gating on a session prevents the RPC
 * ever firing with the anon key at a cold start on /login, which used to
 * discard the whole queue on the first mount (NOT_FOUND_VERSIONED via RLS,
 * or AUTH_FORBIDDEN). `isReplayingRef` is a single-flight guard shared by
 * all three triggers so overlapping triggers never dispatch the same pass
 * twice.
 *
 * Actions are replayed sequentially in the order they were enqueued.
 * - An "unreachable" result mid-pass — NETWORK_OFFLINE (C2), a fetch-level
 *   failure, a locked terminal (N-I1), or no session at all (N-I2,
 *   `isAuthenticated` re-checked per action in case one is lost mid-pass):
 *   none of these are a real server verdict. Left exactly as it was — no
 *   attempt recorded, not dead-lettered — and the rest of the pass is
 *   abandoned. Because nothing about the action changed, nothing else would
 *   ever re-arm a retry for it (e.g. a LAN-up/WAN-down outage never flips
 *   `navigator.onLine` again), so the pass arms its own fixed-interval
 *   retry (`scheduleUnreachableRetry`, `UNREACHABLE_RETRY_MS`, fix round 2)
 *   in addition to whatever trigger picks it up first.
 * - Success, a STALE_VERSION/NOT_FOUND_VERSIONED conflict, or a deterministic
 *   business-rule rejection (`isBusinessRejection`, e.g. INVENTORY_NEGATIVE):
 *   dequeued immediately — none of these would ever succeed on a retry.
 * - Any other (transient/unknown) failure: stays queued with an exponential
 *   backoff (`recordAttempt`) until it has failed MAX_QUEUE_ATTEMPTS times,
 *   at which point it moves to the dead-letter queue (`moveToDeadLetter`)
 *   instead of retrying forever.
 */
export function OfflineQueueProcessor() {
  const isOnline = useOnlineStatus();
  // N-I2 fix: replay must never run without a signed-in session — the RPC
  // would otherwise fire with the anon key, and its RLS-shaped rejection
  // (NOT_FOUND_VERSIONED / AUTH_FORBIDDEN) would look like a real server
  // verdict and discard the action for good (see isUnreachableFailure's
  // per-result auth re-check below for the mid-pass version of this).
  const isAuthenticated = useStaffStore(state => state.isAuthenticated);
  const isReady = isOnline && isAuthenticated;
  // I1 fix: start `false` regardless of the real initial status (not
  // `useRef(isReady)`) so a mount while already ready is itself seen as a
  // "became ready" transition below — replaying a persisted queue on app
  // start (or the moment a session appears), not only on the next
  // connectivity event.
  const wasReadyRef = useRef<boolean>(false);
  const isReplayingRef = useRef<boolean>(false);
  // Fix round 2 (New Breakage 1): the timer a pass arms for itself when it
  // stops on an unreachable result (see `scheduleUnreachableRetry` below).
  // Not the same timer as the backoff-timer effect below — this one is
  // pass-level and never tied to any action's `nextAttemptAt`.
  const unreachableRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // I1 fix: subscribed (not a one-shot getState() read) so the backoff-timer
  // effect below reschedules whenever the queue changes shape (a new
  // nextAttemptAt after a failed attempt, an entry leaving the queue, etc).
  const offlineQueue = useTabStore(state => state.offlineQueue);

  const openTab = useMutationOpenTab();
  const addOrder = useMutationAddOrder();

  // Fix round 2: cancel a pending unreachable-retry on sign-out — whatever
  // stalled the pass, there's no session left to retry it with, and the
  // trigger-level `isReady` gate will schedule a fresh pass on its own once
  // a session reappears. Also clears it on unmount.
  useEffect(() => {
    if (isAuthenticated) return undefined;
    if (unreachableRetryTimerRef.current != null) {
      clearTimeout(unreachableRetryTimerRef.current);
      unreachableRetryTimerRef.current = null;
    }
    return undefined;
  }, [isAuthenticated]);

  useEffect(() => {
    return () => {
      if (unreachableRetryTimerRef.current != null) {
        clearTimeout(unreachableRetryTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const previouslyReady = wasReadyRef.current;
    wasReadyRef.current = isReady;

    const becameReady = isReady && !previouslyReady;
    if (!becameReady) return;

    const queue = useTabStore.getState().offlineQueue;
    if (queue.length === 0) return;
    if (isReplayingRef.current) return;

    void replayQueue(queue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  // I1 fix: backoff must fire on its own, not only on the next connectivity
  // (or, N-I2, auth) edge — schedule a timer for the earliest `nextAttemptAt`
  // in the queue while ready, re-armed whenever the queue changes.
  // `isReplayingRef` (set synchronously at the top of `replayQueue`, before
  // its first await) is the same single-flight guard the transition effect
  // relies on, so a timer firing while a pass from the other trigger is
  // still in flight is a no-op here too.
  useEffect(() => {
    if (!isReady) return undefined;
    const nextAttempts = offlineQueue
      .map(a => a.nextAttemptAt)
      .filter((t): t is number => t != null);
    if (nextAttempts.length === 0) return undefined;

    const delay = Math.max(0, Math.min(...nextAttempts) - Date.now());
    const timerId = window.setTimeout(() => {
      if (isReplayingRef.current) return;
      const queue = useTabStore.getState().offlineQueue;
      if (queue.length === 0) return;
      void replayQueue(queue);
    }, delay);

    return () => {
      window.clearTimeout(timerId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, offlineQueue]);

  async function replayQueue(queue: OfflineAction[]) {
    isReplayingRef.current = true;
    const { setSyncing, dequeueOfflineAction, recordAttempt, moveToDeadLetter } =
      useTabStore.getState();

    setSyncing(true);
    logger.info('offline.queue.replay.start', { count: queue.length });

    // Phase 15 Plan 04: collect actions dropped due to STALE_VERSION /
    // NOT_FOUND_VERSIONED so we can emit a single summary toast post-batch
    // (D-12, D-16 revised — no per-action prompt).
    const discarded: OfflineAction[] = [];
    // Offline-first Plan 01 Task 7: actions that exhausted MAX_QUEUE_ATTEMPTS.
    const deadLettered: OfflineAction[] = [];
    // Fix round 2 (New Breakage 1): true when this pass stopped on an
    // "unreachable" result — nothing else will re-arm a retry for it (the
    // action's own nextAttemptAt is deliberately untouched), so the pass
    // schedules its own fixed-interval retry after the loop, below.
    let stoppedUnreachable = false;
    const now = Date.now();

    for (const action of queue) {
      // N-I2 fix: re-checked every iteration, not just by the trigger-level
      // `isReady` gate — a multi-action pass can outlive the session it
      // started with (logout, expiry). Once it's gone, nothing later in this
      // pass can succeed and every result becomes untrustworthy; stop before
      // even dispatching, and leave everything from here on exactly as it was.
      if (!useStaffStore.getState().isAuthenticated) {
        logger.warn('offline.queue.replay.unauthenticated', {
          actionId: action.id,
          type: action.type,
        });
        break;
      }

      // Final review 1: the staff store stays authenticated through a
      // transient refresh failure, but auth-js then reports no session and
      // supabase-js falls back to the anon key — which PostgREST rejects as
      // AUTH_FORBIDDEN (a "business rejection" that would discard the held
      // order). No session means no trustworthy verdict: hold, spend nothing.
      // A rejected getSession (navigator-lock steal, throwing auth subscriber)
      // is the same "no session" verdict — never let it escape the pass.
      const { data: sessionData } = await supabase.auth
        .getSession()
        .catch(() => ({ data: { session: null } }));
      if (sessionData.session === null) {
        logger.warn('offline.queue.replay.no_auth_session', {
          actionId: action.id,
          type: action.type,
        });
        stoppedUnreachable = true;
        break;
      }

      if (action.nextAttemptAt != null && action.nextAttemptAt > now) {
        logger.debug('offline.queue.replay.skipped_backoff', {
          actionId: action.id,
          type: action.type,
          nextAttemptAt: action.nextAttemptAt,
        });
        continue;
      }

      let dropAndAudit = false;
      let discardAuditAction = 'offline.discarded_stale';
      let failureMessage: string | null = null;
      // Re-review fix round 1 (N-I1/N-I2): true when this dispatch's result
      // isn't a real server verdict at all — the connection dropped (C2), a
      // fetch never got a response, the terminal is license-locked, or the
      // session that was present when this action started dispatching is
      // gone by the time its response comes back. Handled after the
      // try/catch, below: never counted, never dead-lettered.
      let unreachable = false;

      try {
        const result = await dispatchAction(action);
        if (result && !result.ok) {
          const code = result.error.code;
          if (
            isUnreachableFailure(code, result.error.message) ||
            !useStaffStore.getState().isAuthenticated
          ) {
            unreachable = true;
            logger.warn('offline.queue.replay.unreachable_mid_pass', {
              actionId: action.id,
              type: action.type,
              code,
            });
          } else if (code === 'STALE_VERSION' || code === 'NOT_FOUND_VERSIONED') {
            dropAndAudit = true;
            logger.warn('offline.queue.replay.discarded_stale', {
              actionId: action.id,
              type: action.type,
              code,
              expectedVersion: action.expectedVersion,
            });
          } else if (isBusinessRejection(code, result.error.message)) {
            // Fix round 1: a deterministic business-rule rejection (e.g.
            // out-of-stock) will fail identically on every retry — discard
            // it now through the same immediate path a version conflict
            // takes, instead of burning MAX_QUEUE_ATTEMPTS retries on it.
            dropAndAudit = true;
            discardAuditAction = 'offline.discarded_business_rejection';
            logger.warn('offline.queue.replay.discarded_business_rejection', {
              actionId: action.id,
              type: action.type,
              code,
              message: result.error.message,
            });
          } else {
            failureMessage = result.error.message;
            logger.error('offline.queue.replay.action_failed', {
              actionId: action.id,
              type: action.type,
              code,
              message: result.error.message,
            });
          }
        } else {
          logger.info('offline.queue.replay.action_ok', {
            actionId: action.id,
            type: action.type,
          });
          dequeueOfflineAction(action.id);
        }
      } catch (e) {
        failureMessage = e instanceof Error ? e.message : String(e);
        logger.error('offline.queue.replay.action_threw', {
          actionId: action.id,
          type: action.type,
          error: e,
        });
      }

      if (unreachable) {
        // C2/N-I1/N-I2 fix: this attempt never got a trustworthy server
        // verdict — don't spend one of MAX_QUEUE_ATTEMPTS on it (no
        // recordAttempt), and don't dispatch the rest of this pass either,
        // since whatever caused it (dropped connection, unreachable server,
        // a locked terminal, a lost session) applies to the rest of the
        // queue too. The action itself is untouched and stays exactly where
        // it was in the queue; the next trigger picks up where this left off
        // (fix round 2: including a fixed-interval retry this pass arms for
        // itself, below — see `scheduleUnreachableRetry`).
        stoppedUnreachable = true;
        break;
      }

      if (dropAndAudit) {
        dequeueOfflineAction(action.id);
        discarded.push(action);
        writeDiscardAuditAsync(action, discardAuditAction);
        continue;
      }

      if (failureMessage !== null) {
        // Retry-safety audit (offline-first Plan 01 Task 7 report): 'open-tab'
        // is a raw `tabs` insert with no expected-version guard and no
        // idempotency key, so a retried attempt after a success-but-lost-ack
        // failure would create a duplicate tab. Give it a single attempt,
        // same as before this change, and dead-letter it instead of retrying.
        // 'place-order' calls create_order_with_items, which re-checks the
        // expectedVersion captured at enqueue time on every call and bumps
        // tabs.version on success — a retry after a real success is rejected
        // as STALE_VERSION (handled above) rather than duplicated, so it is
        // safe to retry with backoff here.
        const skipRetry = action.type === 'open-tab';
        if (skipRetry || action.retryCount + 1 >= MAX_QUEUE_ATTEMPTS) {
          moveToDeadLetter(action.id, failureMessage);
          deadLettered.push(action);
          writeDiscardAuditAsync(action, 'offline.dead_lettered');
          logger.error('offline.queue.replay.dead_lettered', {
            actionId: action.id,
            type: action.type,
            attempts: action.retryCount + 1,
            reason: skipRetry ? 'no_replay_protection' : 'max_attempts',
          });
        } else {
          recordAttempt(action.id, failureMessage);
        }
      }
    }

    if (discarded.length > 0) {
      toast.error(formatDiscardedSummary(discarded));
    }
    if (deadLettered.length > 0) {
      toast.error(
        i18n.t('common:offlineQueue.deadLettered', { count: deadLettered.length })
      );
    }

    setSyncing(false);
    isReplayingRef.current = false;
    logger.info('offline.queue.replay.done', {
      count: queue.length,
      discarded: discarded.length,
      deadLettered: deadLettered.length,
    });

    if (stoppedUnreachable) {
      scheduleUnreachableRetry();
    }
  }

  /**
   * Fix round 2 (New Breakage 1): arms a fixed-interval, pass-level retry
   * after a pass stops on an unreachable result. Supersedes (clears) any
   * previously-armed one — only the latest stall's timer needs to exist.
   * Deliberately not the same mechanism as the backoff-timer effect above:
   * this never reads or sets `nextAttemptAt`, so it fires regardless of
   * whether the queue's shape changes, which a plain `break` never does.
   */
  function scheduleUnreachableRetry() {
    if (unreachableRetryTimerRef.current != null) {
      clearTimeout(unreachableRetryTimerRef.current);
    }
    unreachableRetryTimerRef.current = setTimeout(() => {
      unreachableRetryTimerRef.current = null;
      if (isReplayingRef.current) return;
      const queue = useTabStore.getState().offlineQueue;
      if (queue.length === 0) return;
      logger.info('offline.queue.replay.unreachable_retry_fired', {
        count: queue.length,
      });
      void replayQueue(queue);
    }, UNREACHABLE_RETRY_MS);
  }

  async function dispatchAction(action: OfflineAction) {
    switch (action.type) {
      case 'open-tab': {
        return openTab.mutateAsync(action.payload as Parameters<typeof openTab.mutateAsync>[0]);
      }
      case 'place-order': {
        // C1 fix: send exactly the version captured at enqueue time — never
        // let the mutation fall back to reading whatever version is in the
        // cache right now (see useMutationAddOrder's mutationFn).
        const payload = action.payload as Omit<
          Parameters<typeof addOrder.mutateAsync>[0],
          'expectedVersion'
        >;
        return addOrder.mutateAsync({ ...payload, expectedVersion: action.expectedVersion });
      }
      case 'start-pool-timer':
      case 'stop-pool-timer': {
        // Pool timer feature removed (Phase 1 strip-rebrand) — any queued action of
        // this type predates the removal and is silently discarded, matching the
        // default unknown-type path below.
        logger.warn('offline.queue.replay.unknown_type', { type: action.type });
        return undefined;
      }
      default: {
        logger.warn('offline.queue.replay.unknown_type', { type: action.type });
        return undefined;
      }
    }
  }

  return null;
}
