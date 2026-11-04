import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import type { OfflineSale, ReRingMarker } from '@shared/lib/offline-sale-schema';
import { err, ok, type Result } from '@shared/lib/result';
import { offlineSaleAuditSummary, recordOfflineSaleAudit } from './audit';
import { offlineSaleTotal } from './replay-outcome';
import { useOfflineSaleStore } from './store';
/* eslint-disable i18next/no-literal-string -- resolution markers and log events, not UI copy. */

const cents = (n: number): number => Math.round(n * 100);

/**
 * Two-mode Plan 02b, Ruling 11b: what a manager does about the price difference when re-selling
 * a refused offline sale at today's price. Pure; money in whole cents so float noise cannot
 * invent a difference, and a sub-cent gap is no gap.
 * - today higher: ring the customer's paid total with a fixed discount for the whole increase
 *   (the manager approves it through the normal discount flow; nothing is proposed silently);
 * - today lower: no discount, the sale is rung at today's price and `customerOverpaid` records
 *   the difference for the cash-variance explanation;
 * - equal: neither.
 */
export function reRingAdjustment(
  paidTotal: number,
  todayTotal: number
): { suggestedDiscount: { amount: number } | null; customerOverpaid: number | null } {
  const diff = cents(todayTotal) - cents(paidTotal);
  if (diff > 0) return { suggestedDiscount: { amount: diff / 100 }, customerOverpaid: null };
  if (diff < 0) return { suggestedDiscount: null, customerOverpaid: -diff / 100 };
  return { suggestedDiscount: null, customerOverpaid: null };
}

/**
 * Sales whose new server sale exists but whose record could not be closed (storage failed, or the
 * record moved), keyed by record id. A module-level memory on purpose: it only has to outlive the
 * next click, and it is the one thing that stops a manager re-ringing the same sale a second time
 * in this session. A restart forgets it; the persisted cart marker covers the normal reload.
 */
const unlinkedReRings = new Map<string, string>();

/** The server tab of a re-ring whose record could not be closed, if any. */
export const unlinkedReRingTab = (saleId: string): string | undefined => unlinkedReRings.get(saleId);

const WRITE_ATTEMPTS = 3;
/** The audit row is the only trace of a re-ring link that survives a restart: a few tries, a beat apart. */
const AUDIT_ATTEMPTS = 3;
const AUDIT_RETRY_DELAY_MS = 1_000;

/**
 * The re-rung sale reached the server, so the old record must close and point at it: an open
 * record would be re-rung (or written off) a second time. `marker` is the one the cart carried
 * when the payment was SENT (the caller captures it before the request, so clearing the cart or
 * filling another re-ring while the answer is on its way cannot change which record closes). It
 * applies `resolved / rering` with the new tab and the customer's overpayment, and returns as soon
 * as that is stored; the `offline_sale_resolved` audit runs detached afterwards (the new sale
 * already exists, so neither the transition nor the cashier waits on an audit call). A storage
 * write that fails is retried, then reported as an error that names the new sale, and the link is
 * audited with `linked: false` so /audit holds it after a restart. Safe to run twice for the same
 * sale. Never throws.
 *
 * A record that is already resolved at a different sale is never re-linked: the refusal is audited
 * with `linked: false` and both tabs (the record itself is not touched). `auditExtra` adds facts
 * to the audit row of a link found on the server (amount, cashier).
 */
export function completeReRing(
  marker: ReRingMarker,
  tabId: string,
  newTotal: number,
  auditExtra: Record<string, unknown> = {}
): Result<OfflineSale> {
  const saleId = marker.saleId;
  const notLinked = (reason: string) => {
    unlinkedReRings.set(saleId, tabId);
    logger.error('offline_sale.rering.not_linked', { saleId, tabId, reason });
    return err({
      code: 'UNKNOWN_ERROR' as const,
      message: i18n.t('featOrders:reviewOfflineSales.reRingNotLinked', { tab: tabId.slice(0, 8) }),
    });
  };
  /** Fire and forget, never awaited (same policy as the replayer's audit); retried, then logged at error. */
  const auditDetached = (
    record: OfflineSale,
    linked: boolean,
    delta: number,
    extra: Record<string, unknown> = {}
  ): void => {
    const write = () =>
      recordOfflineSaleAudit(
        record,
        'offline_sale_resolved',
        tabId,
        offlineSaleAuditSummary(record, record.lastCode ?? null),
        {
          resolution: 'rering',
          ...(linked ? {} : { linked: false }),
          by: marker.approvedBy,
          linkedTabId: tabId,
          delta,
          newTotal,
          approvalId: marker.approvalId,
          ...extra,
        },
        marker.approvedBy
      );
    void (async () => {
      try {
        for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
          if (await write()) return;
          if (attempt < AUDIT_ATTEMPTS) {
            await new Promise<void>(resolve => setTimeout(resolve, AUDIT_RETRY_DELAY_MS));
          }
        }
        logger.error('offline_sale.rering.audit_failed', { saleId, tabId, linked });
      } catch (e: unknown) {
        logger.error('offline_sale.rering.audit_threw', { saleId, tabId, linked }, e);
      }
    })();
  };

  try {
    const record = useOfflineSaleStore.getState().records.find(r => r.id === saleId);
    if (!record) return notLinked('record_missing');
    if (
      record.status === 'resolved' &&
      record.resolution === 'rering' &&
      record.linkedTabId === tabId
    ) {
      unlinkedReRings.delete(saleId);
      return ok(record);
    }
    if (record.status !== 'needs_review') {
      // a second, different sale for a record that is already closed: the only trace is this row
      if (record.status === 'resolved') {
        auditDetached(record, false, 0, { tabId, existingLinkedTabId: record.linkedTabId ?? null });
      }
      return notLinked(`status_${record.status}`);
    }

    const paid = offlineSaleTotal(record) ?? marker.paidTotal;
    const delta = (cents(paid) - cents(newTotal)) / 100;
    const event = {
      type: 'resolved' as const,
      resolution: 'rering' as const,
      by: marker.approvedBy,
      linkedTabId: tabId,
      ...(delta > 0 ? { customerOverpaid: delta } : {}),
    };

    let applied: OfflineSale | undefined;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS && applied === undefined; attempt += 1) {
      const res = useOfflineSaleStore.getState().applyEvent(saleId, event);
      if (!res || res.ignored) return notLinked('event_not_applied');
      if (res.persisted) applied = res.record;
    }
    if (applied === undefined) {
      auditDetached(record, false, delta);
      return notLinked('not_persisted');
    }
    unlinkedReRings.delete(saleId);
    auditDetached(record, true, delta, auditExtra);
    return ok(applied);
  } catch (e) {
    logger.error('offline_sale.rering.complete_threw', { saleId, tabId }, e);
    return notLinked('threw');
  }
}
