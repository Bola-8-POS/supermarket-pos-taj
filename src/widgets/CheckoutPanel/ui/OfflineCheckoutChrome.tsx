/**
 * The cart screen's truthful states for offline selling and for re-ringing a refused offline
 * sale (two-mode Plan 02b). Each piece renders only in its own state; an ordinary online cart
 * shows none of them.
 */
import { CloudOff, RefreshCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  OFFLINE_REASON_PARAMS,
  offlineReasonKey,
  type OfflineRefusalReason,
} from '@features/checkout-sale/model/offlineReasons';
import { provisionalReceiptNumber, useOfflineSaleStore } from '@entities/offline-sale';
import { useProducts } from '@entities/product';
import { formatMoney } from '@shared/lib/format';
import { getCurrentLocale } from '@shared/lib/i18n';
import type { ReRingMarker } from '@shared/lib/offline-sale-schema';
import type { AppError } from '@shared/lib/supabase-contracts';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@shared/ui/alert-dialog';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';

/** Offline, and when the prices on screen were last loaded (Ruling 14). */
export function OfflineChip() {
  const { t } = useTranslation('wPanels');
  const { dataUpdatedAt } = useProducts();
  const loadedAt = dataUpdatedAt > 0 ? new Date(dataUpdatedAt) : null;
  // A restored catalog can be days old: from another day the date matters as much as the time.
  const stamp =
    loadedAt === null
      ? null
      : new Intl.DateTimeFormat(getCurrentLocale(), {
          ...(loadedAt.toDateString() === new Date().toDateString()
            ? {}
            : { day: 'numeric', month: 'short' }),
          hour: 'numeric',
          minute: '2-digit',
        }).format(loadedAt);

  return (
    <Badge variant="warning" data-testid="offline-chip" className="gap-2 px-3 py-1.5 text-sm">
      <CloudOff className="size-4" aria-hidden="true" />
      <span>{t('checkoutPanel.offline.label')}</span>
      <span data-testid="offline-prices-as-of">
        {stamp === null
          ? t('checkoutPanel.offline.pricesFromCache')
          : t('checkoutPanel.offline.pricesAsOf', { time: stamp })}
      </span>
    </Badge>
  );
}

/** The offline limit was reached: nothing else is offered until the stored sales are sent (Ruling 16). */
export function OfflineLimitMessage({ reason, id }: { reason: OfflineRefusalReason; id: string }) {
  const { t } = useTranslation('wPanels');
  return (
    <p
      id={id}
      role="alert"
      data-testid="offline-limit-message"
      className="rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm font-medium text-warning-strong"
    >
      {t(offlineReasonKey(reason), OFFLINE_REASON_PARAMS)}
    </p>
  );
}

/** What the customer paid for the sale being re-rung, and how (the original tender). */
export function ReRingChip({ marker }: { marker: ReRingMarker }) {
  const { t } = useTranslation('wPanels');
  const { t: tr } = useTranslation('receipt');
  const request = useOfflineSaleStore(s => s.records.find(r => r.id === marker.saleId)?.request);

  const methods = request?.legs ? request.legs.map(l => l.method) : request?.method ? [request.method] : [];
  const reference =
    (request?.legs ? request.legs.find(l => l.referenceNumber)?.referenceNumber : request?.referenceNumber) ??
    null;
  const methodLabel = methods
    .map(m => tr(`receipt.method.${m}`, { defaultValue: m }))
    .join(' + ');

  return (
    <div
      data-testid="rering-chip"
      className="flex flex-col gap-0.5 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-strong"
    >
      <p className="flex items-center gap-2 font-semibold">
        <RefreshCcw className="size-4" aria-hidden="true" />
        {t('checkoutPanel.reRing.chip', {
          number: provisionalReceiptNumber(marker.saleId),
          amount: formatMoney(marker.paidTotal),
        })}
      </p>
      <p data-testid="rering-must-match" className="text-xs">
        {t('checkoutPanel.reRing.mustMatch')}
      </p>
      {methodLabel !== '' && (
        <p data-testid="rering-tender" className="text-xs">
          {reference
            ? t('checkoutPanel.reRing.tenderReference', { method: methodLabel, reference })
            : t('checkoutPanel.reRing.tender', { method: methodLabel })}
        </p>
      )}
    </div>
  );
}

/**
 * The new sale went through but the old offline record could not be closed: the cashier must not
 * ring it a third time. Only the button closes it (Escape and outside taps are ignored), because
 * a dismissed warning is how the same customer gets charged twice.
 */
export function ReRingNotLinkedWarning({
  error,
  onAcknowledge,
}: {
  error: AppError;
  onAcknowledge: () => void;
}) {
  const { t } = useTranslation('featOrders');
  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('offlineCheckout.reRingNotLinkedTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{error.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={onAcknowledge}>{t('offlineCheckout.reRingNotLinkedAck')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
