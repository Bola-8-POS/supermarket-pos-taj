import { useCallback, useEffect, useRef } from 'react';
import {
  classifyReplayResult,
  offlineSaleAuditSummary,
  recordOfflineSaleAudit,
  selectNextForReplay,
  useOfflineSaleStore,
  verifySaleIntegrity,
  type OfflineSale,
  type ReplayEvent,
  type ReplayVerdict,
} from '@entities/offline-sale';
import { useStaffStore } from '@entities/staff/model/store';
import { useOnlineStatus } from '@shared/lib/connectivity';
import { callProcessDirectSale } from '@shared/lib/edge-function-contracts';
import { useInstanceRole } from '@shared/lib/instance-lock';
import { logger } from '@shared/lib/logger-instance';
import {
  REPLAY_REQUEST_TIMEOUT_MS,
  REPLAY_SESSION_TIMEOUT_MS,
  UNREACHABLE_RETRY_MS,
} from '@shared/lib/offline-retry';
import { supabase } from '@shared/lib/supabase';
/* eslint-disable i18next/no-literal-string -- audit action names and log events, not UI copy. */

/**
 * What a pass does after one record: take the next one, end quietly, or end and try again later.
 * `skipped`: the record was not sent because another one became the head; it may be picked again.
 */
type Step = 'next' | 'skipped' | 'stop' | 'stalled';

/** A server answer the store could not write down. The record is still `replaying` in memory. */
interface HeldWrite {
  record: OfflineSale;
  event: ReplayEvent | { type: 'tampered' };
  at: number;
  tabId: string | undefined;
}

/** True in the second webview (`/?window=peek`, see main.tsx), which shares localStorage with this window. */
const isProductPeekWindow = (): boolean =>
  new URLSearchParams(window.location.search).get('window') === 'peek';

/**
 * `work`'s answer, or `onTimeout` once `ms` pass without one. The loser is not cancelled: a late
 * answer lands on a promise nobody reads (the callers re-send under the same idempotency key).
 */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(onTimeout);
    }, ms);
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/** `Date.parse`-able ms of the oldest own queued record's next attempt (0 = due now), or null when none. */
function nextDueAt(records: readonly OfflineSale[], staffId: string | undefined): number | null {
  if (staffId === undefined) return null;
  const head = records
    .filter(r => r.status === 'queued' && r.staffId === staffId)
    .sort((a, b) => Date.parse(a.soldAt) - Date.parse(b.soldAt))[0];
  if (!head) return null;
  return head.nextAttemptAt === undefined ? 0 : Date.parse(head.nextAttemptAt);
}

/**
 * Fire-and-forget audit row for a sale that needs a manager or was confirmed after retries
 * (Ruling 12). A failure is logged and never touches the record. The card reference is not
 * copied; the summary is what /audit needs to find the sale again.
 */
function writeAuditAsync(
  record: OfflineSale,
  action: 'offline_sale_needs_review' | 'offline_sale_resolved',
  entityId: string | undefined,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): void {
  void recordOfflineSaleAudit(record, action, entityId, before, after);
}

/** Audit rows owed after `event` took `before` to `after` (needs_review, or confirmed after a retry). */
function auditTransition(
  before: OfflineSale,
  after: OfflineSale,
  event: HeldWrite['event'],
  tabId: string | undefined
): void {
  if (after.status === 'needs_review') {
    writeAuditAsync(
      before,
      'offline_sale_needs_review',
      tabId,
      offlineSaleAuditSummary(before, after.lastCode ?? null),
      { code: after.lastCode ?? null, message: after.lastMessage ?? null, attempts: after.attempts }
    );
  } else if (
    event.type === 'confirmed' &&
    (before.attempts >= 1 || before.lastCode !== undefined)
  ) {
    writeAuditAsync(
      before,
      'offline_sale_resolved',
      tabId,
      offlineSaleAuditSummary(before),
      { resolution: 'confirmed_after_retry', attempts: before.attempts + 1 }
    );
  }
}

/**
 * Headless component that sends each stored offline sale to the server once it is reachable
 * again (two-mode Plan 02b, Rulings 8, 9, 10, 15, 20). A sale ends `confirmed` or in a
 * manager-visible `needs_review`; it is never dropped, sent as two sales, or changed.
 *
 * - FIFO by sale time, one in flight, always with the stored idempotency key. Single flight is
 *   enforced twice: a pass lock here, and the store itself (`replayStarted` is refused unless the
 *   record is `queued`, and `selectNextForReplay` yields nothing while any record is `replaying`).
 *   Nothing is sent unless the `replaying` mark reached storage.
 * - Only the cashier who sold a record replays it (the server takes the staff id from the JWT).
 *   Another cashier's records stay queued.
 * - A pass starts when the terminal becomes ready (reachable AND signed in, also at mount), and
 *   when the oldest own record's `nextAttemptAt` arrives. A transition to ready ignores the
 *   back-off of the first record if it is only an unreachable hold (no counted attempts).
 * - The idle-lock overlay changes neither `isAuthenticated` nor the session, so it does not stop replay.
 * - If storage refuses the write of a server answer, the answer is kept in memory and written at
 *   the start of a later pass; the sale is not sent again meanwhile.
 *
 * Not mounted in the product peek window, which shares this window's storage, and idle in any
 * copy of the app that does not hold the primary-instance lock.
 */
export function OfflineSaleReplayer() {
  if (isProductPeekWindow()) return null;
  return <ActiveReplayer />;
}

function ActiveReplayer() {
  const isOnline = useOnlineStatus();
  const staffId = useStaffStore(s => (s.isAuthenticated ? s.currentStaff?.id : undefined));
  // A second copy of the app (same webview profile) never replays: the primary owns the store.
  const isPrimary = useInstanceRole() === 'primary';
  const isReady = isOnline && staffId !== undefined && isPrimary;
  const due = useOfflineSaleStore(s => nextDueAt(s.records, staffId));

  const wasReadyRef = useRef(false);
  const runningRef = useRef(false);
  const heldRef = useRef<HeldWrite | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Applies an event; keeps it when storage refuses it. */
  const settle = useCallback(
    (record: OfflineSale, event: HeldWrite['event'], tabId: string | undefined): Step => {
      const at = Date.now();
      const res = useOfflineSaleStore.getState().applyEvent(record.id, event, at);
      if (!res || res.ignored) {
        logger.error('offline_sale.replay.event_not_applied', { saleId: record.id, event: event.type });
        return 'stalled';
      }
      if (!res.persisted) {
        heldRef.current = { record, event, at, tabId };
        logger.error('offline_sale.replay.write_held', { saleId: record.id, event: event.type });
        return 'stalled';
      }
      if (event.type === 'refused' || event.type === 'failedUnknown') {
        logger.warn('offline_sale.replay.not_accepted', {
          saleId: record.id,
          event: event.type,
          status: res.record.status,
          code: res.record.lastCode ?? null,
        });
      }
      auditTransition(record, res.record, event, tabId);
      return 'next';
    },
    []
  );

  const replayOne = useCallback(
    async (record: OfflineSale): Promise<Step> => {
      const store = useOfflineSaleStore.getState();

      let intact: boolean;
      try {
        intact = await verifySaleIntegrity(record);
      } catch (e) {
        // Cannot check, so cannot send; leave the record exactly as it is.
        logger.error('offline_sale.replay.integrity_check_failed', { saleId: record.id }, e);
        return 'stalled';
      }
      if (!intact) {
        logger.error('offline_sale.replay.tampered', { saleId: record.id });
        return settle(record, { type: 'tampered' }, undefined);
      }

      // The staff store stays "signed in" through a failed token refresh, and the first replay after a
      // long outage would go out with the expired token (a 401 that would be counted). No session
      // means no trustworthy verdict: hold, count nothing. A rejected getSession is the same.
      // A read that never answers is the same, or the pass lock would hold every cashier's queue.
      const noSession = { data: { session: null } };
      const { data: sessionData } = await withTimeout(
        supabase.auth.getSession().catch(() => noSession),
        REPLAY_SESSION_TIMEOUT_MS,
        noSession
      );
      if (sessionData.session === null) {
        logger.warn('offline_sale.replay.no_auth_session', { saleId: record.id });
        return 'stalled';
      }

      // Everything from here to the send is synchronous. Checked after the awaits: the session is
      // this record's cashier, that cashier is still signed in, and the record is still the head.
      const staff = useStaffStore.getState();
      if (!staff.isAuthenticated || staff.currentStaff?.id !== record.staffId) return 'stop';
      if (sessionData.session.user.id !== record.staffId) {
        // No auth event follows a getSession() on a still-valid token, so arm the retry here.
        logger.warn('offline_sale.replay.session_mismatch', { saleId: record.id });
        return 'stalled';
      }
      const head = selectNextForReplay(record.staffId, Number.MAX_SAFE_INTEGER)(
        useOfflineSaleStore.getState()
      );
      if (head?.id !== record.id) return 'skipped';

      const started = store.applyEvent(record.id, { type: 'replayStarted' });
      if (!started || started.ignored) return 'next';
      if (!started.persisted) {
        logger.error('offline_sale.replay.start_not_persisted', { saleId: record.id });
        return 'stalled';
      }

      let verdict: ReplayVerdict;
      try {
        // No answer in time: outcome unknown, so held and not counted. The sale may well have
        // committed; the re-send under the same key finds out (idempotent), a late answer is dropped.
        const result = await withTimeout(
          callProcessDirectSale(record.request, { offlineReplay: true }),
          REPLAY_REQUEST_TIMEOUT_MS,
          undefined
        );
        if (result === undefined) {
          logger.warn('offline_sale.replay.request_timed_out', { saleId: record.id });
          verdict = { event: { type: 'unreachable' }, tabId: undefined };
        } else {
          verdict = classifyReplayResult(record, result);
        }
      } catch (e) {
        verdict = {
          event: { type: 'failedUnknown', message: e instanceof Error ? e.message : String(e) },
          tabId: undefined,
        };
      }
      if (verdict.event.type === 'refused' && verdict.tabId !== undefined) {
        // The server recorded this sale at a different total: needs a manager, not a retry.
        logger.error('offline_sale.replay.total_differs', { saleId: record.id, tabId: verdict.tabId });
      }
      return settle(record, verdict.event, verdict.tabId);
    },
    [settle]
  );

  /** Writes a held answer. False when storage still refuses it. */
  const writeHeld = useCallback((): boolean => {
    const held = heldRef.current;
    if (!held) return true;
    const res = useOfflineSaleStore.getState().applyEvent(held.record.id, held.event, held.at);
    if (res && !res.ignored && !res.persisted) {
      logger.error('offline_sale.replay.write_still_held', { saleId: held.record.id });
      return false;
    }
    heldRef.current = null;
    if (res && !res.ignored) {
      auditTransition(held.record, res.record, held.event, held.tabId);
    } else {
      logger.error('offline_sale.replay.held_event_not_applied', { saleId: held.record.id });
    }
    return true;
  }, []);

  const runPass = useCallback(
    async (ignoreBackoff: boolean): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      let stalled = false;
      try {
        try {
          useOfflineSaleStore.getState().purge(Date.now());
        } catch (e) {
          logger.warn('offline_sale.replay.purge_failed', { error: e });
        }
        if (!writeHeld()) {
          stalled = true;
          return;
        }

        let skipBackoff = ignoreBackoff;
        // Each record at most once per pass: a record that is picked again right away made no progress.
        const tried = new Set<string>();
        for (;;) {
          const staff = useStaffStore.getState();
          const id = staff.isAuthenticated ? staff.currentStaff?.id : undefined;
          if (id === undefined) return;
          // A reconnect skips the back-off of an unreachable hold (attempts === 0) for this pick only;
          // a record with counted failures keeps it, so a flapping link cannot burn its attempts.
          const state = useOfflineSaleStore.getState();
          const head = skipBackoff ? selectNextForReplay(id, Number.MAX_SAFE_INTEGER)(state) : undefined;
          skipBackoff = false;
          const record = head?.attempts === 0 ? head : selectNextForReplay(id, Date.now())(state);
          if (!record) {
            // Nothing picked although an own sale is queued: its time is not here by the wall clock
            // (stepped back during a hold, a timer that fired early). Nothing else would look again.
            if (tried.size === 0 && state.records.some(r => r.status === 'queued' && r.staffId === id)) {
              stalled = true;
            }
            return;
          }
          if (tried.has(record.id)) return;
          tried.add(record.id);
          const step = await replayOne(record);
          if (step === 'skipped') tried.delete(record.id);
          if (step === 'stop') return;
          if (step === 'stalled') {
            stalled = true;
            return;
          }
        }
      } catch (e) {
        logger.error('offline_sale.replay.pass_failed', {}, e);
        stalled = true;
      } finally {
        runningRef.current = false;
        if (stalled) {
          if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void runPass(false);
          }, UNREACHABLE_RETRY_MS);
        }
      }
    },
    [replayOne, writeHeld]
  );

  // A transition to ready (and a mount while ready, as `wasReady` starts false).
  useEffect(() => {
    const wasReady = wasReadyRef.current;
    wasReadyRef.current = isReady;
    if (isReady && !wasReady) void runPass(true);
  }, [isReady, runPass]);

  // The oldest own record's turn: its back-off ends, or it was just made due (e.g. a manager's Retry).
  useEffect(() => {
    if (!isReady || due === null) return undefined;
    const timer = setTimeout(() => {
      void runPass(false);
    }, Math.max(0, due - Date.now()));
    return () => {
      clearTimeout(timer);
    };
  }, [isReady, due, runPass]);

  useEffect(
    () => () => {
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    },
    []
  );

  return null;
}
