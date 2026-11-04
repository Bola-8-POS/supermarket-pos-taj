import { useMemo } from 'react';
import { useNearExpiryPricingDates } from '@entities/inventory';
import {
  clipAuditText,
  offlineSaleTotal,
  unlinkedReRingTab,
  useOfflineSaleStore,
  verifySaleIntegrity,
  type OfflineSale,
  type OfflineSaleEvent,
} from '@entities/offline-sale';
import { useProducts } from '@entities/product';
import { resolveProductPromotion, usePromotions } from '@entities/promotion';
import { useReceiptSettings, useSettings } from '@entities/settings';
import { useStaffStore } from '@entities/staff/model/store';
import { useCartStore } from '@entities/tab/model/cartStore';
import { isOnline } from '@shared/lib/connectivity';
import {
  ReceiptSettingsSchema,
  UuidSchema,
  type CartItem,
  type Modifier,
  type Product,
  type Staff,
} from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { getInstanceRole } from '@shared/lib/instance-lock';
import { currentLicenseEvaluation } from '@shared/lib/license/store';
import { logger } from '@shared/lib/logger-instance';
import type { ReRingMarker } from '@shared/lib/offline-sale-schema';
import { printReceipt } from '@shared/lib/pos-printer';
import type { StaffAction } from '@shared/lib/rbac';
import { err, ok, type AppErrorCode, type Result } from '@shared/lib/result';
import { ALREADY_WRITTEN_OFF, callResolveOfflineSale, OUTCOME_UNKNOWN } from './resolveOfflineSaleRpc';
/* eslint-disable i18next/no-literal-string -- audit action names, resolution markers and log events, not UI copy. */

/**
 * The manager action that approves resolving an offline sale (two-mode Plan 02c, Ruling 1): the
 * one RBAC action `resolve_offline_sale` gates write-off, re-ring and move-to-review, and only the
 * `resolve_offline_sale` RPC spends a ticket issued for it. Pass it as `requiredAction` to
 * `ManagerPinDialog` and do NOT enable the gate's `offlineCapable` mode: every action here needs
 * the server, and an offline grant would be redeemed with the cashier's own PIN.
 */
export const OFFLINE_SALE_APPROVAL_ACTION: StaffAction = 'resolve_offline_sale';

/** Two-mode Plan 02b, Ruling 11d: a write-off needs a stated reason. */
const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 500;

/**
 * What `ManagerPinDialog` hands back, as the model needs it: `approvalId` and `approver` are the
 * `onSuccess(staff, approvalId)` arguments, `action` is the `requiredAction` the dialog was opened
 * with. The ticket is a server-issued uuid that only the `resolve_offline_sale` RPC spends (for this
 * action, this session and this sale); the model checks it is complete, is for this action and has
 * not been used by an earlier resolution (a module-level set, so a reload within the 15-minute life
 * of a ticket forgets it). The approver's role is the server's to check, so the client does not carry it.
 */
export interface ManagerApprovalTicket {
  approvalId: string;
  action: StaffAction;
  approver: Pick<Staff, 'id'>;
}

export type ResolveOutcome =
  /** The sale was written off; cash and stock effects are the manager's manual job. */
  | { kind: 'written_off'; record: OfflineSale }
  /**
   * The server holds this sale, so nothing was written off; `tabId` is that sale. Such a record has
   * no stored server receipt: reprint it through the normal reprint, by `record.linkedTabId`.
   */
  | { kind: 'already_recorded'; record: OfflineSale; tabId: string }
  /** A re-ring of this sale was already paid (the server found it by an attempt key or a `rering_` key): the record is now linked to that sale `tabId`, and nothing was written off. */
  | { kind: 'already_rerung'; record: OfflineSale; tabId: string }
  | { kind: 'moved_to_review'; record: OfflineSale };

export type ReRingOutcome =
  /**
   * The cart now holds today's version of the sale, marked as a re-ring (see `cartStore.reRing`).
   * `paidTotal` is what the customer paid; feed it and the payment screen's own total to
   * `reRingAdjustment`. The record is untouched until the new sale succeeds.
   */
  | { kind: 'rering'; cartItems: CartItem[]; paidTotal: number }
  /** The server holds this sale, so it was NOT re-rung and the record is resolved; `tabId` is that sale. */
  | { kind: 'already_recorded'; record: OfflineSale; tabId: string }
  /** An earlier re-ring of this sale was already paid, so it was NOT re-rung again; the record is linked to that sale `tabId`. */
  | { kind: 'already_rerung'; record: OfflineSale; tabId: string };

/**
 * Resolution actions for a sale that did not reach the server (two-mode Plan 02b, Ruling 11,
 * Task 6). Every manager action needs an approval ticket from the existing manager PIN gate (see
 * {@link OFFLINE_SALE_APPROVAL_ACTION}; never in its offline-capable mode) and an online connection.
 * The server (`resolve_offline_sale`, 02c) checks the approver, looks the sale up and writes the
 * audit row in the same transaction that spends the ticket; the client reads no table. At most one
 * action per sale runs at a time. None edits the stored request.
 *
 * Contract for callers: every `error.message` these methods return is localised catalog text
 * (`featOrders:reviewOfflineSales.*`) written for the person at the till, including guidance such
 * as "do not re-ring it again" or the names of products that can no longer be sold. A caller may
 * show it as is. No server, database or printer text is ever returned in a message; those go to
 * the log. The `error.code` is for logic, not for choosing wording.
 */
export interface OfflineSaleResolver {
  /** Only the cashier who rang the sale, and only if no re-ring was attempted: it goes back to the queue with its attempts reset. */
  retry: (id: string) => Result<OfflineSale>;
  /** Manager approval, online, reason of at least 10 characters. Checks the server first. */
  writeOff: (
    id: string,
    reason: string,
    approverTicket: ManagerApprovalTicket | undefined
  ) => Promise<Result<ResolveOutcome>>;
  /** Manager approval, online. A queued sale of another cashier, or the signed-in cashier's own held sale, goes to review. Checks the server first. */
  moveToReview: (
    id: string,
    approverTicket: ManagerApprovalTicket | undefined
  ) => Promise<Result<ResolveOutcome>>;
  /**
   * Manager approval, online, the cart empty, the licence not restricted. Asks the server first (a
   * sale it holds is resolved as already recorded and never re-rung), and only on `proceed` fills
   * the cart with the sale's items at today's products and prices, exactly as the checkout screen
   * would add them, and marks the cart as a re-ring. It neither prices the total nor closes the
   * record: the new sale does that (`completeReRing`, called by the checkout when it succeeds), under
   * a `rering_<sale id>_` key the server recognises. Spends the approval; abandoning the cart leaves
   * the record in review and a new re-ring needs a new approval.
   */
  reRing: (
    id: string,
    approverTicket: ManagerApprovalTicket | undefined
  ) => Promise<Result<ReRingOutcome>>;
  /**
   * Prints the server receipt stored with the sale; a provisional receipt is never printed here.
   * `already_recorded` and `rering` records store no receipt: use the normal reprint by `linkedTabId`.
   */
  printConfirmed: (id: string) => Promise<Result<{ jobId: string }>>;
}

// Module level on purpose: every mounted hook and every dialog shares one view of what is running
// and what was spent. A reload clears them; the stored record and its status are the real guard.
const inFlightSales = new Set<string>();
const inFlightApprovals = new Set<string>();
const spentApprovals = new Set<string>();

/** Test hook: these three sets are module state and would otherwise carry one test's locks into the next. */
export function resetResolveStateForTests(): void {
  inFlightSales.clear();
  inFlightApprovals.clear();
  spentApprovals.clear();
}

function refuse(code: AppErrorCode, message: string): Result<never> {
  return err({ code, message });
}

/** Set while another copy of the app owns the offline-sale store: this copy only reads (F3). */
const secondaryRefusal = (): Result<never> | undefined =>
  getInstanceRole() === 'primary'
    ? undefined
    : refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.secondaryInstance'));

/**
 * Why nothing else may resolve or resend this record right now, or undefined. Either its re-ring
 * sits in the checkout cart, or a re-ring was paid and the record could not be closed: in both
 * cases a new sale of the same purchase exists or is about to.
 */
function reRingBlock(id: string): string | undefined {
  if (useCartStore.getState().reRing?.saleId === id) {
    return i18n.t('featOrders:reviewOfflineSales.reRingInProgress');
  }
  const unlinkedTab = unlinkedReRingTab(id);
  return unlinkedTab === undefined
    ? undefined
    : i18n.t('featOrders:reviewOfflineSales.reRingNotLinked', { tab: unlinkedTab.slice(0, 8) });
}

const modifierKey = (modifiers: readonly Pick<Modifier, 'id'>[]): string =>
  modifiers
    .map(m => m.id)
    .sort()
    .join(',');

/** Queued with a retry scheduled: the replayer has tried and is waiting (see the replay machine). */
const isHeld = (record: OfflineSale): boolean =>
  record.status === 'queued' && record.nextAttemptAt !== undefined;

function findRecord(id: string): OfflineSale | undefined {
  return useOfflineSaleStore.getState().records.find(r => r.id === id);
}

/** Who may act on a resolution: signed in, online, a complete and unspent ticket. The server checks the approver, the lookup and the audit. */
function managerPrecheck(
  ticket: ManagerApprovalTicket | undefined
): Result<{ staffId: string; approverId: string; approvalId: string }> {
  const staff = useStaffStore.getState();
  if (!staff.isAuthenticated || !staff.currentStaff) {
    return refuse('AUTH_REQUIRED', i18n.t('featOrders:reviewOfflineSales.notSignedIn'));
  }
  if (!isOnline()) {
    return refuse('NETWORK_OFFLINE', i18n.t('featOrders:reviewOfflineSales.needsConnection'));
  }
  if (
    !ticket ||
    ticket.approvalId.trim() === '' ||
    !UuidSchema.safeParse(ticket.approver.id).success
  ) {
    return refuse('AUTH_FORBIDDEN', i18n.t('featOrders:reviewOfflineSales.approvalRequired'));
  }
  if (ticket.action !== OFFLINE_SALE_APPROVAL_ACTION) {
    return refuse('AUTH_FORBIDDEN', i18n.t('featOrders:reviewOfflineSales.approvalWrongAction'));
  }
  if (spentApprovals.has(ticket.approvalId) || inFlightApprovals.has(ticket.approvalId)) {
    return refuse('AUTH_FORBIDDEN', i18n.t('featOrders:reviewOfflineSales.approvalSpent'));
  }
  return ok({
    staffId: staff.currentStaff.id,
    approverId: ticket.approver.id,
    approvalId: ticket.approvalId,
  });
}

/** One action per sale and one use per approval at a time; always released. */
async function exclusive<T>(
  saleId: string,
  approvalId: string,
  run: () => Promise<Result<T>>
): Promise<Result<T>> {
  if (inFlightSales.has(saleId)) {
    return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.busy'));
  }
  inFlightSales.add(saleId);
  inFlightApprovals.add(approvalId);
  try {
    return await run();
  } finally {
    inFlightSales.delete(saleId);
    inFlightApprovals.delete(approvalId);
  }
}

/** Does the stored key still match its digest? A tampered key is never sent to the server. */
async function keyIsTrusted(record: OfflineSale): Promise<Result<boolean>> {
  try {
    return ok(await verifySaleIntegrity(record));
  } catch (e) {
    logger.error('offline_sale.resolve.integrity_check_failed', { saleId: record.id }, e);
    return refuse('SUPABASE_ERROR', i18n.t('featOrders:reviewOfflineSales.serverCheckFailed'));
  }
}

/**
 * Remembers on a record in review that the server may hold a write-off of it: the answer to a resolution
 * call was lost (it may have committed), or the server said it already wrote the sale off. Only the sale
 * being resolved clears it, so no other refusal does (one can be raised before the server even looks).
 */
function noteResolutionAnswer(id: string, answer: Result<unknown>, lostAnswerCounts = true): void {
  if (answer.ok) return;
  // a lost re-ring answer is safe to repeat (a re-ring never commits a write-off), so only a write-off's counts
  if (!(lostAnswerCounts && answer.error.detail === OUTCOME_UNKNOWN) && answer.error.detail !== ALREADY_WRITTEN_OFF) return;
  const current = useOfflineSaleStore.getState().records.find(r => r.id === id);
  if (!current || current.resolutionOutcomeUnknown) return;
  const res = useOfflineSaleStore.getState().applyEvent(id, { type: 'resolutionOutcomeUnknown' });
  // not stored (storage full): Retry and Re-ring stay open until the app reloads
  if (res && !res.persisted) logger.warn('offline_sale.resolve.lost_answer_flag_not_stored', { saleId: id });
}

/** Applies the transitions to the stored record, in order; the first one that cannot be stored ends the run. */
function applyEvents(record: OfflineSale, events: OfflineSaleEvent[]): Result<OfflineSale> {
  let current = record;
  for (const event of events) {
    const res = useOfflineSaleStore.getState().applyEvent(record.id, event);
    if (!res) return refuse('NOT_FOUND', i18n.t('featOrders:reviewOfflineSales.notFound'));
    if (res.ignored) {
      logger.error('offline_sale.resolve.event_not_applied', { saleId: record.id, event: event.type });
      return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notAwaitingReview'));
    }
    if (!res.persisted) {
      logger.error('offline_sale.resolve.not_persisted', { saleId: record.id, event: event.type });
      return refuse('UNKNOWN_ERROR', i18n.t('featOrders:reviewOfflineSales.notStored'));
    }
    current = res.record;
  }
  return ok(current);
}

type LinkOutcome = Extract<ResolveOutcome, { kind: 'already_recorded' | 'already_rerung' }>;

/**
 * Links the record to the server sale the answer names (the one place a link is stored). When the
 * server sale holds less than the offline sale (`amountShort`, computed by the server, split sales
 * included) it goes on the record as `amountShort` — never as `customerOverpaid`, which only a
 * re-ring at a lower price sets.
 */
function linkRecord(
  record: OfflineSale,
  outcome: LinkOutcome['kind'],
  tabId: string,
  by: string,
  amountShort: number,
  duplicateReringTabId: string | undefined,
  before: OfflineSaleEvent[] = []
): Result<LinkOutcome> {
  const done = applyEvents(record, [
    ...before,
    {
      type: 'resolved',
      resolution: outcome === 'already_recorded' ? 'already_recorded' : 'rering',
      by,
      linkedTabId: tabId,
      ...(amountShort > 0 ? { amountShort } : {}),
      ...(duplicateReringTabId !== undefined ? { duplicateReringTabId } : {}),
    },
  ]);
  return done.ok ? ok({ kind: outcome, record: done.data, tabId }) : done;
}

/** One request line, resolved against today's catalog, ready to go through the cart store's own add API. */
interface ReRingLine {
  product: Product;
  modifiers: Modifier[];
  quantity: number;
  weightGrams: number | undefined;
  notes: string;
  /** The promotion-discounted unit price (the LINE total when weighted), as the checkout screen stamps it; undefined = list price. */
  unitPrice: number | undefined;
  promotionId: string | null;
}

/**
 * Fills the (empty) cart from resolved lines and marks it, in one synchronous run. The marker goes
 * first so that any line in the cart implies the link, and the pending key is cleared so the new
 * sale mints its own: the record's key is never copied. Throws if the cart store cannot be written;
 * the caller empties the cart then.
 */
export function fillReRingCart(lines: ReRingLine[], marker: ReRingMarker): void {
  const cart = useCartStore.getState();
  cart.clearPendingIdempotencyKey();
  cart.setReRing(marker);
  for (const line of lines) {
    if (line.weightGrams !== undefined) {
      // A weighed line is one weighing: never multiply the weight. The resolver already refuses a
      // weighed record with quantity != 1, so this only fires if that guard is ever loosened.
      if (line.quantity !== 1) {
        logger.warn('offline_sale.rering.weighed_quantity_ignored', {
          productId: line.product.id,
          quantity: line.quantity,
        });
      }
      cart.addWeightedItem(line.product, line.weightGrams, line.unitPrice, line.promotionId);
    } else {
      for (let n = 0; n < line.quantity; n += 1) {
        cart.addItem(line.product, line.modifiers, line.unitPrice, line.promotionId);
      }
    }
    if (line.notes !== '') {
      const key = modifierKey(line.modifiers);
      // the line just added is the last one of its kind (a weighted line is always new, never merged)
      const target = useCartStore
        .getState()
        .items.filter(
          item =>
            item.product.id === line.product.id &&
            (item.weightGrams != null) === (line.weightGrams !== undefined) &&
            modifierKey(item.selectedModifiers) === key
        )
        .pop();
      if (target) cart.setItemNotes(target.tempId, line.notes);
    }
  }
}

export function useResolveOfflineSale(): OfflineSaleResolver {
  const { data: receiptSettings } = useReceiptSettings();
  // The four sources the checkout screen prices a line from, so a re-rung line costs what the
  // same product scanned now would. Required, not optional: a line priced without them would
  // be refused by the server as AMOUNT_MISMATCH.
  const { data: products } = useProducts();
  const { data: promotions } = usePromotions();
  const { data: settings } = useSettings();
  const { data: nearExpiry } = useNearExpiryPricingDates();

  return useMemo<OfflineSaleResolver>(
    () => ({
      retry: id => {
        const secondary = secondaryRefusal();
        if (secondary) return secondary;
        if (!useStaffStore.getState().isAuthenticated) {
          return refuse('AUTH_REQUIRED', i18n.t('featOrders:reviewOfflineSales.notSignedIn'));
        }
        if (inFlightSales.has(id)) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.busy'));
        }
        const record = findRecord(id);
        if (!record) return refuse('NOT_FOUND', i18n.t('featOrders:reviewOfflineSales.notFound'));
        if (record.status !== 'needs_review') {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notAwaitingReview'));
        }
        // only the selling cashier's session can replay it (the server checks their shift); anyone else re-rings or writes off
        if (record.staffId !== useStaffStore.getState().currentStaff?.id) {
          return refuse('AUTH_FORBIDDEN', i18n.t('featOrders:reviewOfflineSales.retryNotSeller'));
        }
        // a re-ring was tried and may be paid: sending the original again would be two sales of one purchase
        if (record.reRingAttemptKeys.length > 0) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.retryAfterReRing'));
        }
        // the answer to a write-off or re-ring was lost: the server may already have written this sale off
        if (record.resolutionOutcomeUnknown) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.retryAfterLostWriteOff'));
        }
        // sending it again while its re-ring is open or unlinked would be two sales of one purchase
        const blocked = reRingBlock(id);
        if (blocked !== undefined) return refuse('VALIDATION_ERROR', blocked);
        const res = useOfflineSaleStore.getState().applyEvent(id, { type: 'retryRequested' });
        if (!res || res.ignored) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notAwaitingReview'));
        }
        if (!res.persisted) {
          return refuse('UNKNOWN_ERROR', i18n.t('featOrders:reviewOfflineSales.notStored'));
        }
        return ok(res.record);
      },

      writeOff: async (id, reason, ticket) => {
        const secondary = secondaryRefusal();
        if (secondary) return secondary;
        const pre = managerPrecheck(ticket);
        if (!pre.ok) return pre;
        const { approverId: ticketApproverId, approvalId } = pre.data;
        const trimmed = reason.trim();
        if (trimmed.length < REASON_MIN_LENGTH) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.reasonTooShort'));
        }
        const record = findRecord(id);
        if (!record) return refuse('NOT_FOUND', i18n.t('featOrders:reviewOfflineSales.notFound'));
        if (record.status !== 'needs_review') {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notAwaitingReview'));
        }
        const blocked = reRingBlock(id);
        if (blocked !== undefined) return refuse('VALIDATION_ERROR', blocked);
        const clippedReason = clipAuditText(trimmed, REASON_MAX_LENGTH);

        return exclusive(id, approvalId, async (): Promise<Result<ResolveOutcome>> => {
          const trusted = await keyIsTrusted(record);
          if (!trusted.ok) return trusted;
          // the server looks the sale up, spends the ticket and writes the audit row in one transaction
          const answer = await callResolveOfflineSale({
            intent: 'write_off',
            record,
            trusted: trusted.data,
            reason: clippedReason,
            approvalId,
            approverId: ticketApproverId,
          });
          noteResolutionAnswer(id, answer);
          if (!answer.ok) return answer;
          const { outcome, tabId, approverId: by, amountShort, duplicateReringTabId } = answer.data;

          // The server spent the ticket and wrote its row whatever happens to the record below.
          spentApprovals.add(approvalId);
          // Every check ran on `record`; the store replaces a record on any change, so anything but
          // the very same object means it moved (the replayer, another window) while the server was asked.
          if (findRecord(id) !== record) {
            return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notAwaitingReview'));
          }
          if (outcome === 'written_off') {
            const done = applyEvents(record, [{ type: 'resolved', resolution: 'written_off', by }]);
            return done.ok ? ok({ kind: 'written_off', record: done.data }) : done;
          }
          if ((outcome === 'already_recorded' || outcome === 'already_rerung') && tabId !== undefined) {
            return linkRecord(record, outcome, tabId, by, amountShort, duplicateReringTabId);
          }
          // proceed / moved_to_review (or a link without a tab) cannot answer a write-off
          logger.warn('offline_sale.resolve.unexpected_outcome', { saleId: id, outcome });
          return refuse('SUPABASE_ERROR', i18n.t('featOrders:reviewOfflineSales.serverCheckFailed'));
        });
      },

      moveToReview: async (id, ticket) => {
        const secondary = secondaryRefusal();
        if (secondary) return secondary;
        const pre = managerPrecheck(ticket);
        if (!pre.ok) return pre;
        const { approverId: ticketApproverId, approvalId } = pre.data;
        const record = findRecord(id);
        if (!record) return refuse('NOT_FOUND', i18n.t('featOrders:reviewOfflineSales.notFound'));
        if (record.status !== 'queued') {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notQueued'));
        }
        // The cashier who rang it sends it, unless it is HELD: no counted answer, a retry scheduled
        // and possibly forever (outcome unknown, 5xx, auth). Then it is the way out for their own sale too.
        if (record.staffId === pre.data.staffId && !isHeld(record)) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.ownSale'));
        }

        return exclusive(id, approvalId, async (): Promise<Result<ResolveOutcome>> => {
          const trusted = await keyIsTrusted(record);
          if (!trusted.ok) return trusted;
          // the server looks the sale up, spends the ticket and writes the audit row in one transaction
          const answer = await callResolveOfflineSale({
            intent: 'review',
            record,
            trusted: trusted.data,
            reason: undefined,
            approvalId,
            approverId: ticketApproverId,
          });
          if (!answer.ok) return answer;
          const { outcome, tabId, approverId: by, amountShort, duplicateReringTabId } = answer.data;
          // The server spent the ticket and wrote its row whatever happens to the record below.
          spentApprovals.add(approvalId);
          // The record moved (the replayer, another window) while the server was asked.
          if (findRecord(id) !== record) {
            return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notAwaitingReview'));
          }
          // That cashier may have signed in while the server was asked: then the replayer owns it.
          const now = useStaffStore.getState();
          if (!now.isAuthenticated || !now.currentStaff) {
            return refuse('AUTH_REQUIRED', i18n.t('featOrders:reviewOfflineSales.notSignedIn'));
          }
          if (record.staffId === now.currentStaff.id && !isHeld(record)) {
            return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.ownSale'));
          }

          if (outcome === 'already_recorded' && tabId !== undefined) {
            // resolved is only reachable from review, so the sale passes through it
            return linkRecord(record, outcome, tabId, by, amountShort, duplicateReringTabId, [{ type: 'escalated' }]);
          }
          if (outcome === 'moved_to_review') {
            const done = applyEvents(record, [{ type: 'escalated' }]);
            return done.ok ? ok({ kind: 'moved_to_review', record: done.data }) : done;
          }
          // Another intent's stored outcome (or a link without a tab) cannot answer this request.
          logger.warn('offline_sale.resolve.unexpected_outcome', { saleId: id, outcome });
          return refuse('SUPABASE_ERROR', i18n.t('featOrders:reviewOfflineSales.serverCheckFailed'));
        });
      },

      reRing: async (id, ticket) => {
        const secondary = secondaryRefusal();
        if (secondary) return secondary;
        const pre = managerPrecheck(ticket);
        if (!pre.ok) return pre;
        const { approverId: ticketApproverId, approvalId } = pre.data;
        const record = findRecord(id);
        if (!record) return refuse('NOT_FOUND', i18n.t('featOrders:reviewOfflineSales.notFound'));
        if (record.status !== 'needs_review') {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notAwaitingReview'));
        }
        const cartBusy = () =>
          refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.reRingCartNotEmpty'));
        if (useCartStore.getState().items.length > 0) return cartBusy();
        // The new sale exists but its record could not be closed: ringing it again is the double sale.
        // the server may already have written this sale off: a new sale would be counted twice
        if (record.resolutionOutcomeUnknown) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.reRingAfterLostWriteOff'));
        }
        const blocked = reRingBlock(id);
        if (blocked !== undefined) return refuse('VALIDATION_ERROR', blocked);
        // Ruling 19: the sale that follows would be blocked once the approval was spent, so ask nothing.
        if (currentLicenseEvaluation().state === 'restricted') {
          return refuse(
            'LICENSE_RESTRICTED',
            i18n.t('featOrders:reviewOfflineSales.reRingLicenseRestricted')
          );
        }

        return exclusive(id, approvalId, async (): Promise<Result<ReRingOutcome>> => {
          const trusted = await keyIsTrusted(record);
          if (!trusted.ok) return trusted;
          // Without a trusted key the server cannot be asked whether it already holds this sale,
          // and selling it again is the one thing this action must never do. Writing off still works.
          if (!trusted.data) {
            return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.reRingUntrusted'));
          }

          const paidTotal = offlineSaleTotal(record);
          if (paidTotal === undefined) {
            return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.reRingNoTotal'));
          }
          if (!products || !promotions || !settings) {
            return refuse('SUPABASE_ERROR', i18n.t('featOrders:reviewOfflineSales.reRingCatalogNotLoaded'));
          }

          // Plan every line against today's catalog before asking the server, so a local refusal
          // spends no approval, and before touching the cart, so a refusal leaves it empty.
          const missing: string[] = [];
          const lines: ReRingLine[] = [];
          record.request.items.forEach((item, i) => {
            const product = products.find(p => p.id === item.productId);
            const modifiers = (
              product ? item.modifierIds.map(mid => product.modifiers.find(m => m.id === mid)) : []
            ).filter((m): m is Modifier => m !== undefined);
            const weighted = item.weightGrams != null;
            const sellable =
              product !== undefined &&
              modifiers.length === item.modifierIds.length &&
              weighted === product.soldByWeight &&
              (!weighted || (item.quantity === 1 && modifiers.length === 0));
            if (!sellable) {
              missing.push(record.lines[i]?.name ?? item.productId);
              return;
            }
            const match = resolveProductPromotion(
              product,
              promotions,
              settings,
              nearExpiry,
              undefined,
              item.weightGrams ?? undefined
            );
            lines.push({
              product,
              modifiers,
              quantity: item.quantity,
              weightGrams: item.weightGrams ?? undefined,
              notes: item.notes ?? '',
              unitPrice: match?.discountedUnitPrice,
              promotionId: match?.promotionId ?? null,
            });
          });
          if (missing.length > 0) {
            return refuse(
              'VALIDATION_ERROR',
              i18n.t('featOrders:reviewOfflineSales.reRingProductsMissing', { items: missing.join(', ') })
            );
          }

          // The server decides: a sale it holds, or a re-ring it already saw paid, is linked and never
          // rung again; `proceed` is the one answer that lets a new sale be rung. It also writes the
          // `rering_approved` row the server needs before it recognises the new payment as this re-ring.
          const answer = await callResolveOfflineSale({
            intent: 'rering',
            record,
            trusted: true,
            reason: undefined,
            approvalId,
            approverId: ticketApproverId,
          });
          noteResolutionAnswer(id, answer, false);
          if (!answer.ok) return answer;
          const { outcome, tabId, approverId: by, amountShort, duplicateReringTabId } = answer.data;
          // The server spent the ticket and wrote its row whatever happens to the record or cart below.
          spentApprovals.add(approvalId);

          // Back on the same tick as the fill: the record and the cart are what they were checked as.
          if (findRecord(id) !== record) {
            return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notAwaitingReview'));
          }
          if ((outcome === 'already_recorded' || outcome === 'already_rerung') && tabId !== undefined) {
            return linkRecord(record, outcome, tabId, by, amountShort, duplicateReringTabId);
          }
          if (outcome !== 'proceed') {
            // Another intent's stored outcome (or a link without a tab) cannot answer a re-ring.
            logger.warn('offline_sale.resolve.unexpected_outcome', { saleId: id, outcome });
            return refuse('SUPABASE_ERROR', i18n.t('featOrders:reviewOfflineSales.serverCheckFailed'));
          }
          if (useCartStore.getState().items.length > 0) return cartBusy();
          try {
            fillReRingCart(lines, { saleId: id, approvedBy: by, approvalId, paidTotal });
          } catch (e) {
            logger.error('offline_sale.rering.fill_failed', { saleId: id }, e);
            try {
              useCartStore.getState().clearCart();
            } catch (clearError) {
              logger.error('offline_sale.rering.clear_failed', { saleId: id }, clearError);
            }
            return refuse('UNKNOWN_ERROR', i18n.t('featOrders:reviewOfflineSales.notStored'));
          }
          return ok({ kind: 'rering', cartItems: useCartStore.getState().items, paidTotal });
        });
      },

      printConfirmed: async id => {
        if (!useStaffStore.getState().isAuthenticated) {
          return refuse('AUTH_REQUIRED', i18n.t('featOrders:reviewOfflineSales.notSignedIn'));
        }
        const record = findRecord(id);
        if (!record) return refuse('NOT_FOUND', i18n.t('featOrders:reviewOfflineSales.notFound'));
        if (record.slimmed === true) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.printUnavailable'));
        }
        const receipt = record.confirmedReceipt;
        // Only a receipt the server produced; the schema strips the provisional marker, and a
        // stored object that still carries it is refused rather than printed as confirmed.
        if (receipt === undefined || 'provisional' in receipt) {
          return refuse('VALIDATION_ERROR', i18n.t('featOrders:reviewOfflineSales.notConfirmed'));
        }
        const printed = await printReceipt(receipt, receiptSettings ?? ReceiptSettingsSchema.parse({}));
        if (printed.ok) return printed;
        // the printer's own text is for the log, never for the screen
        logger.warn('offline_sale.print_confirmed_failed', {
          saleId: id,
          code: printed.error.code,
          message: printed.error.message,
        });
        return refuse(printed.error.code, i18n.t('featOrders:reviewOfflineSales.printFailed'));
      },
    }),
    [receiptSettings, products, promotions, settings, nearExpiry]
  );
}
