import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ReceiptSettings } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { sendReceiptByEmail } from '@shared/lib/email-receipt';
import { ReceiptEmailSchema } from '@shared/lib/email-schema';
import { LockedFeature, POSButton } from '@shared/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';

export interface EmailReceiptDialogProps {
  receipt: ReceiptData;
  settings: ReceiptSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EmailReceiptDialog({
  receipt,
  settings,
  open,
  onOpenChange,
}: EmailReceiptDialogProps) {
  const { t } = useTranslation('featOrders');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setEmail('');
      setError(null);
    }
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    setError(null);
    const parsed = ReceiptEmailSchema.safeParse(email);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? t('processPayment.invalidEmail');
      setError(msg);
      return;
    }
    setPending(true);
    const result = await sendReceiptByEmail(receipt, parsed.data, settings);
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    toast.success(
      result.data.pdfAttached
        ? t('processPayment.receiptSent')
        : t('processPayment.receiptSentNoPdf')
    );
    setEmail('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('processPayment.emailReceiptTitle')}</DialogTitle>
          <DialogDescription>{t('processPayment.emailReceiptDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="receipt-email">{t('processPayment.emailLabel')}</Label>
          <Input
            id="receipt-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => {
              setEmail(e.target.value);
            }}
            placeholder={t('processPayment.emailPlaceholder')}
            disabled={pending}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <POSButton
            type="button"
            variant="outline"
            touchSize="large"
            disabled={pending}
            onClick={() => {
              handleOpenChange(false);
            }}
          >
            {t('common:actions.cancel')}
          </POSButton>
          <LockedFeature feature="email_receipts">
            <POSButton
              type="button"
              touchSize="large"
              disabled={pending}
              onClick={() => {
                void handleSubmit();
              }}
            >
              {pending ? t('processPayment.sending') : t('processPayment.sendReceipt')}
            </POSButton>
          </LockedFeature>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
