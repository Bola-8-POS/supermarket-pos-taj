import type { OfflineSaleLastCode } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { UNREACHABLE_RETRY_MS, computeBackoffMs } from '@shared/lib/offline-retry';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { OFFLINE_SALE_LIMITS } from './limits';

/** Pure state machine for one offline sale (two-mode Plan 02b, Rulings 8-10). No React, no store. */
export type OfflineSaleEvent =
  /** The sale was stored; a no-op on a `queued` record (creation happens in the store). */
  | { type: 'enqueued' }
  | { type: 'replayStarted' }
  | { type: 'confirmed'; tabId: string; receipt: ReceiptData }
  /** Outcome unknown (502/503/504, fetch failure, licence guard): back to queued, not counted. */
  | { type: 'unreachable' }
  /** Deterministic business refusal: straight to needs_review. */
  | {
      type: 'refused';
      code: Exclude<OfflineSaleLastCode, 'UNKNOWN' | 'TAMPERED' | 'ESCALATED'>;
      message: string;
      /** The server already recorded this sale (a success at a different total): kept so a manager never re-rings it. */
      tabId?: string;
    }
  /** Any other failure: counted, backed off, needs_review once attempts are exhausted. */
  | { type: 'failedUnknown'; message: string }
  | { type: 'retryRequested' }
  | {
      type: 'resolved';
      resolution: 'rering' | 'written_off' | 'already_recorded';
      by: string;
      linkedTabId?: string;
      customerOverpaid?: number;
      amountShort?: number;
      duplicateReringTabId?: string;
    }
  | { type: 'tampered' }
  /** A re-ring payment is about to be sent under `key`: remembered on the record (deduplicated, capped), needs_review only. */
  | { type: 'reRingAttempted'; key: string }
  /**
   * A manager hands a sale to review that its own cashier cannot send (the server takes the staff
   * id from the JWT, so nobody else can replay it): queued only, attempts kept, local code `ESCALATED`.
   */
  | { type: 'escalated' }
  /** The server may hold a write-off of this sale (a lost answer, or it said so): Retry and Re-ring are refused until it is resolved. needs_review only. */
  | { type: 'resolutionOutcomeUnknown' };

const iso = (ms: number): string => new Date(ms).toISOString();

/** The next record, or undefined when the event cannot apply in the current status. */
function transition(sale: OfflineSale, event: OfflineSaleEvent, now: number): OfflineSale | undefined {
  // confirmed and resolved are terminal: nothing moves them.
  if (sale.status === 'confirmed' || sale.status === 'resolved') return undefined;

  switch (event.type) {
    case 'enqueued':
      return sale.status === 'queued' ? sale : undefined;

    case 'replayStarted':
      return sale.status === 'queued'
        ? { ...sale, status: 'replaying', nextAttemptAt: undefined }
        : undefined;

    case 'confirmed':
      return sale.status === 'replaying'
        ? {
            ...sale,
            status: 'confirmed',
            tabId: event.tabId,
            confirmedReceipt: event.receipt,
            confirmedAt: iso(now),
            lastCode: undefined,
            lastMessage: undefined,
            nextAttemptAt: undefined,
          }
        : undefined;

    case 'unreachable':
      return sale.status === 'replaying'
        ? { ...sale, status: 'queued', nextAttemptAt: iso(now + UNREACHABLE_RETRY_MS) }
        : undefined;

    case 'refused':
      return sale.status === 'replaying'
        ? {
            ...sale,
            status: 'needs_review',
            lastCode: event.code,
            lastMessage: event.message,
            tabId: event.tabId ?? sale.tabId,
            nextAttemptAt: undefined,
          }
        : undefined;

    case 'failedUnknown': {
      if (sale.status !== 'replaying') return undefined;
      const attempts = sale.attempts + 1;
      if (attempts >= OFFLINE_SALE_LIMITS.maxAttempts) {
        return {
          ...sale,
          status: 'needs_review',
          attempts,
          lastCode: 'UNKNOWN',
          lastMessage: event.message,
          nextAttemptAt: undefined,
        };
      }
      return {
        ...sale,
        status: 'queued',
        attempts,
        lastMessage: event.message,
        nextAttemptAt: iso(now + computeBackoffMs(attempts)),
      };
    }

    case 'retryRequested':
      // a re-ring may already be paid: resending the original sale could make two sales of one purchase
      return sale.status === 'needs_review' &&
        sale.reRingAttemptKeys.length === 0 &&
        !sale.resolutionOutcomeUnknown
        ? { ...sale, status: 'queued', attempts: 0, nextAttemptAt: undefined }
        : undefined;

    case 'resolved':
      return sale.status === 'needs_review'
        ? {
            ...sale,
            status: 'resolved',
            resolution: event.resolution,
            resolvedBy: event.by,
            resolvedAt: iso(now),
            resolutionOutcomeUnknown: false,
            linkedTabId: event.linkedTabId,
            customerOverpaid: event.customerOverpaid,
            amountShort: event.amountShort,
            duplicateReringTabId: event.duplicateReringTabId,
            nextAttemptAt: undefined,
          }
        : undefined;

    case 'reRingAttempted': {
      if (sale.status !== 'needs_review') return undefined;
      if (sale.reRingAttemptKeys.includes(event.key)) return sale;
      return {
        ...sale,
        reRingAttemptKeys: [...sale.reRingAttemptKeys, event.key].slice(
          -OFFLINE_SALE_LIMITS.maxReRingAttemptKeys
        ),
      };
    }

    case 'resolutionOutcomeUnknown':
      if (sale.status !== 'needs_review') return undefined;
      return sale.resolutionOutcomeUnknown ? sale : { ...sale, resolutionOutcomeUnknown: true };

    case 'tampered':
      return sale.status === 'queued' || sale.status === 'replaying'
        ? {
            ...sale,
            status: 'needs_review',
            lastCode: 'TAMPERED',
            lastMessage: undefined,
            nextAttemptAt: undefined,
          }
        : undefined;

    case 'escalated':
      return sale.status === 'queued'
        ? {
            ...sale,
            status: 'needs_review',
            lastCode: 'ESCALATED',
            lastMessage: undefined,
            nextAttemptAt: undefined,
          }
        : undefined;
  }
}

/** Total: an event that cannot apply returns the record unchanged. */
export function reduceOfflineSale(sale: OfflineSale, event: OfflineSaleEvent, now: number): OfflineSale {
  return transition(sale, event, now) ?? sale;
}

/** Same as {@link reduceOfflineSale} but says whether the event was impossible (and so ignored). */
export function applyOfflineSaleEvent(
  sale: OfflineSale,
  event: OfflineSaleEvent,
  now: number
): { record: OfflineSale; ignored: boolean } {
  const next = transition(sale, event, now);
  return next === undefined ? { record: sale, ignored: true } : { record: next, ignored: false };
}
