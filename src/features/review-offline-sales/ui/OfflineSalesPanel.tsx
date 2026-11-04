import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { offlineSaleTotal } from '@entities/offline-sale';
import type { Staff } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { getCurrentLocale } from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import type { OfflineSale } from '@shared/lib/offline-sale-schema';
import { FormField, POSButton } from '@shared/ui';
import { Badge } from '@shared/ui/badge';
import { Textarea } from '@shared/ui/textarea';
import {
  OFFLINE_SALE_APPROVAL_ACTION,
  type ManagerApprovalTicket,
  type OfflineSaleResolver,
} from '../model/useResolveOfflineSale';

/* eslint-disable i18next/no-literal-string -- test ids, route paths and catalog key prefixes, not UI copy. */

/** Two-mode Plan 02b, Ruling 11d: mirrors the model's own check; the model is the control. */
const WRITE_OFF_MIN_LENGTH = 10;
/** The model clips the reason it audits at 500 characters; the field stops there too. */
const WRITE_OFF_MAX_LENGTH = 500;
const CATALOG = 'reviewOfflineSales.dialog';

type ManagerAction = 'reRing' | 'writeOff' | 'moveToReview';
interface PinTarget {
  action: ManagerAction;
  id: string;
  /** The row's status when the action was chosen; a refusal leaves it unchanged. */
  status: OfflineSale['status'];
}
interface Notice {
  tone: 'success' | 'error';
  text: string;
  /** Shown only while the row is still in this status. */
  status: OfflineSale['status'];
}

export interface OfflineSalesPanelProps {
  records: readonly OfflineSale[];
  /** The signed-in cashier; a queued sale of anyone else, or their own held one, can move to review (Ruling 8, F4). */
  signedInStaffId: string | undefined;
  resolver: OfflineSaleResolver;
  /** The inventory page is reachable only with `adjust_inventory`. */
  canAdjustStock: boolean;
  /** Closes the dialog that hosts this panel. */
  onClose: () => void;
}

/** Display order of the groups (brief: needs review, pending, confirmed, resolved). */
const GROUPS = [
  { key: 'needsReview', statuses: ['needs_review'] },
  { key: 'pending', statuses: ['queued', 'replaying'] },
  { key: 'confirmed', statuses: ['confirmed'] },
  { key: 'resolved', statuses: ['resolved'] },
] as const;

const shortNumber = (id: string): string => id.slice(0, 8).toUpperCase();

function methodOf(record: OfflineSale): 'cash' | 'card' | 'split' | 'other' {
  const { legs, method } = record.request;
  if (legs !== undefined) {
    const [first] = legs;
    if (legs.length === 1 && first && (first.method === 'cash' || first.method === 'card')) {
      return first.method;
    }
    return legs.length > 1 ? 'split' : 'other';
  }
  return method === 'cash' || method === 'card' ? method : 'other';
}

function formatSoldAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(getCurrentLocale(), { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * The review list and its actions (two-mode Plan 02b, Task 7). Presentational over its props so a
 * story can render it with a stub resolver; `OfflineSalesDialog` supplies the real one.
 *
 * Every manager action opens the manager PIN gate once; the approval it yields goes straight into
 * that one model call and is not kept anywhere, so the next action asks again. The gate is never
 * opened in its offline-capable mode: every action here needs the server.
 */
export function OfflineSalesPanel({
  records,
  signedInStaffId,
  resolver,
  canAdjustStock,
  onClose,
}: OfflineSalesPanelProps) {
  const { t } = useTranslation('featOrders');
  const navigate = useNavigate();
  const [pinFor, setPinFor] = useState<PinTarget | undefined>();
  const [writeOffDraft, setWriteOffDraft] = useState<{ id: string; reason: string } | undefined>();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const inFlightIds = useRef(new Set<string>());
  const [notices, setNotices] = useState<Readonly<Record<string, Notice>>>({});
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // the cashier can type the reason at once
  const draftId = writeOffDraft?.id;
  useEffect(() => {
    if (draftId !== undefined) reasonRef.current?.focus();
  }, [draftId]);

  const grouped = useMemo(
    () =>
      GROUPS.map(group => ({
        key: group.key,
        rows: records
          .filter(r => (group.statuses as readonly string[]).includes(r.status))
          .sort((a, b) => Date.parse(b.soldAt) - Date.parse(a.soldAt)),
      })).filter(group => group.rows.length > 0),
    [records]
  );

  // A notice belongs to the state its row was in when it was written, and goes when that changes.
  const say = (id: string, status: OfflineSale['status'], tone: Notice['tone'], text: string) => {
    setNotices(prev => ({ ...prev, [id]: { tone, text, status } }));
  };
  const clearNotice = (id: string) => {
    setNotices(prev => {
      if (!(id in prev)) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id));
    });
  };
  // The model's refusals are localised catalog text written for this screen (see `OfflineSaleResolver`).
  const sayRefusal = (id: string, status: OfflineSale['status'], message: string) => {
    say(id, status, 'error', message);
  };
  const alreadyRecorded = (id: string, record: OfflineSale, tabId: string) => {
    say(id, record.status, 'success', t(`${CATALOG}.notices.alreadyRecorded`, { number: shortNumber(tabId) }));
  };

  const alreadyReRung = (id: string, record: OfflineSale, tabId: string) => {
    say(id, record.status, 'success', t(`${CATALOG}.notices.alreadyReRung`, { number: shortNumber(tabId) }));
  };

  /** Runs one action on one row; that row's buttons stay disabled until it settles, whatever happens. */
  async function run(id: string, status: OfflineSale['status'], action: () => Promise<void>) {
    // `busyIds` is state: two taps in one task both see it empty. The ref flips synchronously.
    if (inFlightIds.current.has(id)) return;
    inFlightIds.current.add(id);
    clearNotice(id);
    setBusyIds(prev => new Set(prev).add(id));
    try {
      await action();
    } catch (e) {
      logger.error('offline_sale.review_action_failed', { saleId: id }, e);
      sayRefusal(id, status, t(`${CATALOG}.failed`));
    } finally {
      inFlightIds.current.delete(id);
      setBusyIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function askApproval(action: ManagerAction, record: OfflineSale) {
    setPinFor({ action, id: record.id, status: record.status });
  }

  function onApproved(approver: Staff, approvalId: string) {
    const target = pinFor;
    // The gate closes with its approval; nothing but the target outlives this call.
    setPinFor(undefined);
    if (!target) return;
    const ticket: ManagerApprovalTicket = {
      approvalId,
      action: OFFLINE_SALE_APPROVAL_ACTION,
      approver: { id: approver.id },
    };
    const { id, status } = target;
    void run(id, status, async () => {
      if (target.action === 'reRing') {
        const res = await resolver.reRing(id, ticket);
        if (!res.ok) {
          sayRefusal(id, status, res.error.message);
        } else if (res.data.kind === 'already_recorded') {
          alreadyRecorded(id, res.data.record, res.data.tabId);
        } else if (res.data.kind === 'already_rerung') {
          alreadyReRung(id, res.data.record, res.data.tabId);
        } else {
          // the model has filled the cart; hand over to the checkout
          onClose();
          void navigate('/pos');
        }
      } else if (target.action === 'writeOff') {
        const reason = writeOffDraft?.id === id ? writeOffDraft.reason : '';
        const res = await resolver.writeOff(id, reason, ticket);
        if (!res.ok) {
          sayRefusal(id, status, res.error.message);
        } else {
          setWriteOffDraft(prev => (prev?.id === id ? undefined : prev));
          if (res.data.kind === 'already_recorded') alreadyRecorded(id, res.data.record, res.data.tabId);
          else if (res.data.kind === 'already_rerung') alreadyReRung(id, res.data.record, res.data.tabId);
          else say(id, res.data.record.status, 'success', t(`${CATALOG}.notices.writtenOff`));
        }
      } else {
        const res = await resolver.moveToReview(id, ticket);
        if (!res.ok) sayRefusal(id, status, res.error.message);
        else if (res.data.kind === 'already_recorded') alreadyRecorded(id, res.data.record, res.data.tabId);
        else say(id, res.data.record.status, 'success', t(`${CATALOG}.notices.movedToReview`));
      }
    });
  }

  function retry(record: OfflineSale) {
    clearNotice(record.id);
    const res = resolver.retry(record.id);
    if (res.ok) say(record.id, res.data.status, 'success', t(`${CATALOG}.notices.retried`));
    else sayRefusal(record.id, record.status, res.error.message);
  }

  function printConfirmed(record: OfflineSale) {
    void run(record.id, record.status, async () => {
      const res = await resolver.printConfirmed(record.id);
      if (res.ok) say(record.id, record.status, 'success', t(`${CATALOG}.notices.printed`));
      else sayRefusal(record.id, record.status, res.error.message);
    });
  }

  /** What the PIN approves: the action in plain words, the sale's receipt number, total and cashier. */
  function pinDescription(target: PinTarget): string {
    const record = records.find(r => r.id === target.id);
    const total = record ? offlineSaleTotal(record) : undefined;
    return t(`${CATALOG}.pinPrompt.${target.action}`, {
      receiptNumber: record?.receiptNumber ?? target.id.slice(0, 8).toUpperCase(),
      total: total === undefined ? '—' : formatMoney(total),
      cashier: record?.staffName ?? '—',
    });
  }

  if (grouped.length === 0) {
    return <p className="py-8 text-center text-muted-foreground">{t(`${CATALOG}.empty`)}</p>;
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">{t(`${CATALOG}.managerHint`)}</p>

      {grouped.map(group => (
        <section key={group.key} aria-labelledby={`offline-group-${group.key}`} className="space-y-2">
          <h3 id={`offline-group-${group.key}`} className="text-sm font-semibold">
            {t(`${CATALOG}.groups.${group.key}`)} ({group.rows.length})
          </h3>
          <ul className="space-y-2">
            {group.rows.map(record => {
              const total = offlineSaleTotal(record);
              const own = record.staffId === signedInStaffId;
              const busy = busyIds.has(record.id);
              const notice = notices[record.id];
              const shownNotice = notice?.status === record.status ? notice : undefined;
              const draft = writeOffDraft?.id === record.id ? writeOffDraft : undefined;
              const trimmedLength = draft?.reason.trim().length ?? 0;
              const reasonTooShort = draft !== undefined && trimmedLength < WRITE_OFF_MIN_LENGTH;
              const lastCode = record.lastCode ?? 'UNKNOWN';
              // a sale whose stored data fails its checksum is never re-sent or re-rung (the model refuses both)
              const resendable = lastCode !== 'TAMPERED';
              // a sale of the signed-in cashier that stays unconfirmed: a manager can take it from here
              const heldOwn = own && record.status === 'queued' && record.nextAttemptAt !== undefined;
              const receiptNumber = record.receiptNumber;
              const label = (action: string) => t(`${CATALOG}.actionLabels.${action}`, { receiptNumber });
              return (
                <li
                  key={record.id}
                  data-testid="offline-sale-row"
                  data-status={record.status}
                  data-receipt-number={receiptNumber}
                  className="space-y-2 rounded-lg border border-border bg-card p-3"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-sm font-semibold">{receiptNumber}</span>
                    {record.status === 'confirmed' && record.tabId ? (
                      <span className="text-sm">
                        {t(`${CATALOG}.serverReceipt`, { number: shortNumber(record.tabId) })}
                      </span>
                    ) : null}
                    <Badge
                      data-testid="offline-sale-state"
                      variant={
                        record.status === 'needs_review'
                          ? 'destructive'
                          : record.status === 'confirmed'
                            ? 'success'
                            : 'muted'
                      }
                    >
                      {t(`${CATALOG}.status.${record.status}`)}
                    </Badge>
                    <span className="text-sm text-muted-foreground">{formatSoldAt(record.soldAt)}</span>
                    {total !== undefined ? (
                      <span className="text-sm font-medium">{formatMoney(total)}</span>
                    ) : null}
                    <span className="text-sm text-muted-foreground">
                      {t(`${CATALOG}.method.${methodOf(record)}`)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t(`${CATALOG}.cashier`, { name: record.staffName })}
                    </span>
                  </div>

                  {record.status === 'needs_review' ? (
                    <div className="space-y-1">
                      <p data-testid="offline-sale-reason" className="text-sm">
                        {t(`${CATALOG}.reason.${lastCode}`)}
                      </p>
                      {record.lastMessage ? (
                        <p
                          data-testid="offline-sale-server-detail"
                          className="text-xs text-muted-foreground"
                        >
                          {t(`${CATALOG}.serverDetail`, { message: record.lastMessage })}
                        </p>
                      ) : null}
                      {lastCode === 'INVENTORY_NEGATIVE' && !canAdjustStock ? (
                        <p data-testid="offline-sale-ask-manager-stock" className="text-sm font-medium">
                          {t(`${CATALOG}.askManagerStock`)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {record.status === 'queued' || record.status === 'replaying' ? (
                    <p className="text-sm text-muted-foreground">
                      {own
                        ? t(`${CATALOG}.waitingOwn`)
                        : t(`${CATALOG}.waitingOther`, { name: record.staffName })}
                    </p>
                  ) : null}

                  {heldOwn ? (
                    <p data-testid="offline-sale-held-own" className="text-sm font-medium">
                      {t(`${CATALOG}.heldOwn`)}
                    </p>
                  ) : null}

                  {record.status === 'resolved' && record.resolution ? (
                    <p className="text-sm text-muted-foreground">
                      {t(`${CATALOG}.resolution.${record.resolution}`)}
                      {record.linkedTabId
                        ? ` · ${t(`${CATALOG}.linkedSale`, { number: shortNumber(record.linkedTabId) })}`
                        : ''}
                      {record.customerOverpaid !== undefined && record.customerOverpaid > 0
                        ? ` · ${t(`${CATALOG}.overpaid`, { amount: formatMoney(record.customerOverpaid) })}`
                        : ''}
                      {record.amountShort !== undefined && record.amountShort > 0
                        ? ` · ${t(`${CATALOG}.shortfall`, { amount: formatMoney(record.amountShort) })}`
                        : ''}
                      {record.duplicateReringTabId ? (
                        <span data-testid="offline-sale-duplicate-rering" className="mt-1 block">
                          {t(`${CATALOG}.duplicateRering`, { number: shortNumber(record.duplicateReringTabId) })}
                        </span>
                      ) : null}
                    </p>
                  ) : null}

                  {draft ? (
                    <div className="space-y-2">
                      <FormField
                        label={t(`${CATALOG}.writeOff.reasonLabel`)}
                        {...(reasonTooShort && trimmedLength > 0
                          ? { error: t('reviewOfflineSales.reasonTooShort') }
                          : { hint: t(`${CATALOG}.writeOff.reasonHint`) })}
                      >
                        <Textarea
                          ref={reasonRef}
                          value={draft.reason}
                          placeholder={t(`${CATALOG}.writeOff.reasonPlaceholder`)}
                          disabled={busy}
                          maxLength={WRITE_OFF_MAX_LENGTH}
                          onChange={e => {
                            setWriteOffDraft({ id: record.id, reason: e.target.value });
                          }}
                        />
                      </FormField>
                      <div className="flex flex-wrap gap-2">
                        <POSButton
                          type="button"
                          variant="destructive"
                          focusEmphasis="high"
                          aria-label={label('confirmWriteOff')}
                          disabled={reasonTooShort || busy}
                          onClick={() => {
                            askApproval('writeOff', record);
                          }}
                        >
                          {t(`${CATALOG}.writeOff.confirm`)}
                        </POSButton>
                        <POSButton
                          type="button"
                          variant="outline"
                          focusEmphasis="high"
                          aria-label={label('cancelWriteOff')}
                          disabled={busy}
                          onClick={() => {
                            setWriteOffDraft(undefined);
                          }}
                        >
                          {t('common:actions.cancel')}
                        </POSButton>
                      </div>
                    </div>
                  ) : null}

                  {shownNotice ? (
                    <p
                      role={shownNotice.tone === 'error' ? 'alert' : 'status'}
                      className={
                        shownNotice.tone === 'error'
                          ? 'text-sm font-medium text-destructive'
                          : 'text-sm font-medium text-success-strong'
                      }
                    >
                      {shownNotice.text}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {record.status === 'needs_review' && !draft ? (
                      <>
                        {resendable && own && record.reRingAttemptKeys.length === 0 && !record.resolutionOutcomeUnknown ? (
                          <POSButton
                            type="button"
                            variant="outline"
                            focusEmphasis="high"
                            data-testid="offline-sale-retry"
                            aria-label={label('retry')}
                            disabled={busy}
                            onClick={() => {
                              retry(record);
                            }}
                          >
                            {t(`${CATALOG}.actions.retry`)}
                          </POSButton>
                        ) : null}
                        {resendable && !record.resolutionOutcomeUnknown ? (
                          <POSButton
                            type="button"
                            focusEmphasis="high"
                            data-testid="offline-sale-rering"
                            aria-label={label('reRing')}
                            disabled={busy}
                            onClick={() => {
                              askApproval('reRing', record);
                            }}
                          >
                            {t(`${CATALOG}.actions.reRing`)}
                          </POSButton>
                        ) : null}
                        <POSButton
                          type="button"
                          variant="destructive"
                          focusEmphasis="high"
                          data-testid="offline-sale-writeoff"
                          aria-label={label('writeOff')}
                          disabled={busy}
                          onClick={() => {
                            clearNotice(record.id);
                            setWriteOffDraft({ id: record.id, reason: '' });
                          }}
                        >
                          {t(`${CATALOG}.actions.writeOff`)}
                        </POSButton>
                        {lastCode === 'INVENTORY_NEGATIVE' && canAdjustStock ? (
                          <POSButton
                            asChild
                            variant="outline"
                            focusEmphasis="high"
                            data-testid="offline-sale-adjust-stock"
                          >
                            {/* The inventory page preselects this reason. */}
                            <Link to="/inventory?adjustReason=offline_sale_reconciliation" aria-label={label('adjustStock')} onClick={onClose}>
                              {t(`${CATALOG}.actions.adjustStock`)}
                            </Link>
                          </POSButton>
                        ) : null}
                      </>
                    ) : null}
                    {record.status === 'queued' && signedInStaffId !== undefined && (!own || heldOwn) ? (
                      <POSButton
                        type="button"
                        variant="outline"
                        focusEmphasis="high"
                        data-testid="offline-sale-move-to-review"
                        aria-label={label('moveToReview')}
                        disabled={busy}
                        onClick={() => {
                          askApproval('moveToReview', record);
                        }}
                      >
                        {t(`${CATALOG}.actions.moveToReview`)}
                      </POSButton>
                    ) : null}
                    {record.status === 'confirmed' && record.slimmed === true ? (
                      <p data-testid="offline-sale-print-unavailable" className="text-sm text-muted-foreground">
                        {t('reviewOfflineSales.printUnavailable')}
                      </p>
                    ) : null}
                    {record.status === 'confirmed' && record.slimmed !== true ? (
                      <POSButton
                        type="button"
                        variant="outline"
                        focusEmphasis="high"
                        data-testid="offline-sale-print-confirmed"
                        aria-label={label('printConfirmed')}
                        disabled={busy}
                        onClick={() => {
                          printConfirmed(record);
                        }}
                      >
                        {t(`${CATALOG}.actions.printConfirmed`)}
                      </POSButton>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {pinFor ? (
        <ManagerPinDialog
          description={pinDescription(pinFor)}
          open
          onOpenChange={open => {
            if (!open) setPinFor(undefined);
          }}
          requiredAction={OFFLINE_SALE_APPROVAL_ACTION}
          onSuccess={onApproved}
        />
      ) : null}
    </div>
  );
}
