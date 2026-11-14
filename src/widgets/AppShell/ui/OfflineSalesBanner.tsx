import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OfflineSalesDialog } from '@features/review-offline-sales';
import { useOfflineSaleStore } from '@entities/offline-sale';
import { useStaffStore } from '@entities/staff/model/store';
import { getCurrentLocale } from '@shared/lib/i18n';
import { useInstanceRole } from '@shared/lib/instance-lock';
import { POSButton } from '@shared/ui';

/**
 * Persistent strip for sales rung while the backend was unreachable (two-mode Plan 02b, Ruling 12).
 * Shown to every role on this terminal: "N offline sales pending" (neutral), "M need review"
 * (destructive, announced, never dismissible: it leaves only when the sales do), "sale storage is full"
 * when an answer or a new sale could not be stored even after settled sales gave way, and, when a queued
 * sale belongs to another cashier, who it is waiting for (only that cashier's session can send it,
 * Ruling 8). One button opens the review dialog. Renders nothing when no sale is waiting.
 *
 * A second running copy of the app (it does not hold the primary-instance lock) adds a persistent
 * line saying offline sales are handled in the other window.
 *
 * Subscribes to the stable `records` array (the entity's selectors return a fresh array per call,
 * which Zustand v5 would re-render forever) and derives the counts here. The dialog, and the
 * resolution hook it mounts, only exist while it is open.
 */
export function OfflineSalesBanner() {
  const { t } = useTranslation('wPanels');
  const records = useOfflineSaleStore(s => s.records);
  const storageFull = useOfflineSaleStore(s => s.storageFull);
  const signedInId = useStaffStore(s => s.currentStaff?.id);
  const [open, setOpen] = useState(false);
  const secondary = useInstanceRole() === 'secondary';

  const { pending, review, waiting } = useMemo(() => {
    const queuedOrSending = records.filter(r => r.status === 'queued' || r.status === 'replaying');
    // one entry per cashier (by id), shown by name
    const byId = new Map<string, string>();
    for (const r of queuedOrSending) {
      if (r.status === 'queued' && r.staffId !== signedInId) byId.set(r.staffId, r.staffName);
    }
    return {
      pending: queuedOrSending.length,
      review: records.filter(r => r.status === 'needs_review').length,
      waiting: [...byId.values()],
    };
  }, [records, signedInId]);

  const hasWork = pending > 0 || review > 0 || storageFull;
  // The dialog outlives the strip: settling the last sale from inside it must not close it.
  if (!hasWork && !open && !secondary) return null;

  const needsReview = review > 0;
  return (
    <>
      {secondary ? (
        <div
          data-testid="offline-sales-secondary"
          role="status"
          className="shrink-0 bg-warning-soft px-4 py-1.5 text-center text-sm font-medium text-warning-strong"
        >
          {t('appShell.offlineSales.secondaryInstance')}
        </div>
      ) : null}
      {hasWork ? (
        <div
          data-testid="offline-sales-banner"
          className={
            needsReview
              ? 'flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 bg-destructive px-4 py-1.5 text-sm font-semibold text-destructive-foreground'
              : 'flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 bg-muted px-4 py-1.5 text-sm font-medium text-foreground'
          }
        >
          {needsReview ? (
            <span role="alert" data-testid="offline-sales-review-count">
              {t('appShell.offlineSales.needReview', { count: review })}
            </span>
          ) : null}
          {pending > 0 ? (
            <span role="status" data-testid="offline-sales-pending-count">
              {t('appShell.offlineSales.pending', { count: pending })}
            </span>
          ) : null}
          {storageFull ? (
            <span role="alert" data-testid="offline-sales-storage-full">
              {t('appShell.offlineSales.storageFull')}
            </span>
          ) : null}
          {waiting.length > 0 ? (
            <span>
              {t('appShell.offlineSales.waitingFor', {
                count: waiting.length,
                names: new Intl.ListFormat(getCurrentLocale(), { type: 'conjunction' }).format(waiting),
              })}
            </span>
          ) : null}
          <POSButton
            type="button"
            variant="outline"
            touchSize="default"
            focusEmphasis="high"
            data-testid="offline-sales-open-review"
            onClick={() => {
              setOpen(true);
            }}
          >
            {t('appShell.offlineSales.review')}
          </POSButton>
        </div>
      ) : null}
      {open ? <OfflineSalesDialog open onOpenChange={setOpen} /> : null}
    </>
  );
}
