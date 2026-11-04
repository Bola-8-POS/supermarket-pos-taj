import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useOfflineSaleStore } from '@entities/offline-sale';
import { useReceiptSettings } from '@entities/settings';
import { ReceiptSettingsSchema } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { printJobErrorCopyKey, printReceipt } from '@shared/lib/pos-printer';
import { POSButton } from '@shared/ui';

type ChipState = 'pending' | 'confirmed' | 'review' | 'resolved';

const STATE_COPY: Record<ChipState, string> = {
  pending: 'receipt.provisional.pendingConfirmation',
  confirmed: 'receipt.provisional.confirmed',
  review: 'receipt.provisional.needsReview',
  resolved: 'receipt.provisional.resolved',
};

/**
 * Where a provisional sale stands, read live from its stored record. The record is found by id
 * (the provisional receipt carries it as `tabId`): the `P-` number is only six hex characters of
 * it, so two sales can share one. Once the server has confirmed it, the confirmed receipt can be
 * printed: the copy the server returned, never the provisional one.
 *
 * The print guard and error handling repeat a few lines of `useResolveOfflineSale.printConfirmed`
 * on purpose: that lives in a hook that mounts the RBAC, catalog and promotion queries, which a
 * receipt screen has no use for.
 */
export function ProvisionalStatusChip({ recordId }: { recordId: string }) {
  const { t } = useTranslation('receipt');
  const { t: tf } = useTranslation('featOrders');
  const { t: tp } = useTranslation('wPanels');
  const [printing, setPrinting] = useState(false);
  // `printing` is state: two taps in one task both see it false. The ref flips synchronously.
  const printingRef = useRef(false);
  const status = useOfflineSaleStore(s => s.records.find(r => r.id === recordId)?.status);
  const confirmedReceipt = useOfflineSaleStore(
    s => s.records.find(r => r.id === recordId)?.confirmedReceipt
  );
  const slimmed = useOfflineSaleStore(s => s.records.find(r => r.id === recordId)?.slimmed === true);
  const { data: receiptSettings } = useReceiptSettings();

  const state: ChipState =
    status === 'confirmed'
      ? 'confirmed'
      : status === 'needs_review'
        ? 'review'
        : status === 'resolved'
          ? 'resolved'
          : 'pending';

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <p
        role="status"
        data-testid="provisional-status-chip"
        data-state={state}
        className="rounded-full border border-border bg-muted px-3 py-1 text-sm font-semibold"
      >
        {t(STATE_COPY[state])}
      </p>
      {state === 'confirmed' && slimmed && (
        <p data-testid="provisional-print-unavailable" className="text-sm text-muted-foreground">
          {tf('reviewOfflineSales.printUnavailable')}
        </p>
      )}
      {state === 'confirmed' && confirmedReceipt && !('provisional' in confirmedReceipt) && (
        <POSButton
          type="button"
          variant="outline"
          touchSize="large"
          disabled={printing}
          onClick={() => {
            if (printingRef.current) return;
            printingRef.current = true;
            setPrinting(true);
            void (async () => {
              try {
                const printed = await printReceipt(
                  confirmedReceipt,
                  receiptSettings ?? ReceiptSettingsSchema.parse({})
                );
                if (!printed.ok) {
                  logger.warn('offline_sale.print_confirmed_failed', {
                    saleId: recordId,
                    code: printed.error.code,
                  });
                  toast.error(tf(printJobErrorCopyKey(printed.error.code)));
                }
              } catch (error) {
                logger.warn('offline_sale.print_confirmed_failed', { saleId: recordId, raw: String(error) });
                toast.error(tp('paymentForm.printOrDrawerFailed'));
              } finally {
                printingRef.current = false;
                setPrinting(false);
              }
            })();
          }}
        >
          {t('receipt.provisional.printConfirmed')}
        </POSButton>
      )}
    </div>
  );
}
