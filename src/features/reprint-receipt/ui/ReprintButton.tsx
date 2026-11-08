/**
 * ReprintButton — reconstructs and reprints a completed sale's full receipt.
 *
 * No dialog, no PIN gate: reprint is a read-only, non-destructive action
 * (RESEARCH.md Open Questions #2 / 13-UI-SPEC.md Interaction Contract).
 * Renders unconditionally for every payment row — unlike its siblings, it
 * is not scoped to the clicked row's tender leg; it reconstructs the whole
 * sale grouped by tabId (RESEARCH.md Pitfall 4 / CR-03).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { fetchReceiptDataForPayment, paymentReceiptKeys, type Payment } from '@entities/payment';
import { usePrintJob } from '@entities/print-job';
import { useReceiptSettings } from '@entities/settings';
import { ReceiptSettingsSchema } from '@shared/lib/domain';
import { isTauri, printJobErrorCopyKey, printReceipt } from '@shared/lib/pos-printer';
import { POSButton, PrintJobStatusBadge } from '@shared/ui';

export interface ReprintButtonProps {
  payment: Payment;
}

export function ReprintButton({ payment }: ReprintButtonProps) {
  const { t } = useTranslation('wPanels');
  const [busy, setBusy] = useState(false);
  // Tracks the most recent printReceipt() call's job id from this specific
  // button — undefined until the first print attempt resolves, so no badge
  // renders before that (D-05, augments the existing button, doesn't
  // replace it). Non-Tauri (web fallback) prints have no durable broker job
  // behind them, so they never set this either.
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const { data: settings } = useReceiptSettings();
  const queryClient = useQueryClient();
  const { data: job } = usePrintJob(jobId ?? '');

  async function handleClick() {
    setBusy(true);
    try {
      const receipt = await queryClient.fetchQuery({
        queryKey: paymentReceiptKeys.byTab(payment.tabId),
        queryFn: () => fetchReceiptDataForPayment(payment.tabId),
      });
      const printed = await printReceipt(receipt, settings ?? ReceiptSettingsSchema.parse({}));
      if (!printed.ok) {
        toast.error(t(printJobErrorCopyKey(printed.error.code)));
      } else if (isTauri()) {
        setJobId(printed.data.jobId);
      }
      // No toast on success — a successful durable acceptance stays silent;
      // the status badge is the only signal of eventual outcome, per
      // UI-SPEC's no-success-toast rule (PRN-04/UX).
    } catch {
      toast.error(t('paymentPane.reprintDataFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <POSButton
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          void handleClick();
        }}
      >
        {busy ? t('paymentPane.reprinting') : t('paymentPane.reprint')}
      </POSButton>
      {job && (
        <PrintJobStatusBadge
          status={job.status}
          onReprint={() => {
            void handleClick();
          }}
        />
      )}
    </div>
  );
}
