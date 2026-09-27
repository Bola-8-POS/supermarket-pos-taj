import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useReceiptSettings } from '@entities/settings';
import { ReceiptSettingsSchema } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { downloadReceiptPdf } from '@shared/lib/exporters/receipt-pdf.tsx';
import { getCurrentLocale } from '@shared/lib/i18n';
import { isLicenseEnforced } from '@shared/lib/license/config';
import { isDemoPlan } from '@shared/lib/license/features';
import { useLicenseStore } from '@shared/lib/license/store';
import { printJobErrorCopyKey, printReceipt } from '@shared/lib/pos-printer';
import { buildThermalReceiptText } from '@shared/lib/receipt-format';
import { LockedFeature, POSButton } from '@shared/ui';
import { EmailReceiptDialog } from './EmailReceiptDialog';

export interface ReceiptPreviewProps {
  receipt: ReceiptData;
  onDone: () => void;
}

export function ReceiptPreview({ receipt, onDone }: ReceiptPreviewProps) {
  const { t } = useTranslation('featOrders');
  const [emailOpen, setEmailOpen] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const { data: receiptSettings } = useReceiptSettings();
  const settings = receiptSettings ?? ReceiptSettingsSchema.parse({});
  const demoWatermark = isLicenseEnforced() && isDemoPlan(useLicenseStore.getState().payload);
  const text = buildThermalReceiptText(receipt, getCurrentLocale(), settings, { demoWatermark });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t('processPayment.receiptTitle')}</h2>
      {/* text-[11px] mirrors the 58mm thermal printer's fixed character width (buildThermalReceiptText) — off the UI type ramp deliberately, so the preview's line-wrap matches the physical receipt. */}
      <pre className="max-h-[50vh] overflow-auto rounded-xl border border-border bg-muted/40 p-4 font-mono text-[11px] leading-tight whitespace-pre">
        {text}
      </pre>
      <div className="flex flex-col flex-wrap gap-2 sm:flex-row">
        <POSButton
          type="button"
          touchSize="large"
          className="flex-1"
          disabled={printBusy}
          onClick={() => {
            setPrintBusy(true);
            void (async () => {
              try {
                const result = await printReceipt(receipt, settings);
                if (!result.ok) {
                  toast.error(t(printJobErrorCopyKey(result.error.code)));
                }
                // No toast on success — a successful durable acceptance stays
                // silent (status badge only, wired in a later plan); see
                // UI-SPEC's no-success-toast rule (PRN-04/UX).
              } finally {
                setPrintBusy(false);
              }
            })();
          }}
        >
          {printBusy ? t('processPayment.printing') : t('processPayment.printReceipt')}
        </POSButton>
        <LockedFeature feature="email_receipts">
          <POSButton
            type="button"
            variant="outline"
            touchSize="large"
            className="flex-1"
            onClick={() => {
              setEmailOpen(true);
            }}
          >
            {t('processPayment.emailReceiptButton')}
          </POSButton>
        </LockedFeature>
        <POSButton
          type="button"
          variant="outline"
          touchSize="large"
          className="flex-1"
          disabled={pdfBusy}
          onClick={() => {
            setPdfBusy(true);
            void downloadReceiptPdf(receipt, settings, { demoWatermark })
              .then(result => {
                if (!result.ok && result.error.code !== 'EXPORT_CANCELLED') {
                  toast.error(t('processPayment.pdfGenerationFailed'));
                }
              })
              .finally(() => {
                setPdfBusy(false);
              });
          }}
        >
          {pdfBusy ? t('processPayment.generatingPdf') : t('processPayment.downloadPdfButton')}
        </POSButton>
        <POSButton
          type="button"
          variant="secondary"
          touchSize="large"
          className="flex-1"
          onClick={onDone}
        >
          {t('processPayment.done')}
        </POSButton>
      </div>
      <EmailReceiptDialog
        receipt={receipt}
        settings={settings}
        open={emailOpen}
        onOpenChange={setEmailOpen}
      />
    </div>
  );
}
