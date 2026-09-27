/**
 * ConfirmTransferDialog — two-step gate for confirming a pending bank
 * transfer: code entry (client-side Luhn typo check, D-08) -> manager PIN ->
 * confirm_transfer_payment mutation.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ManagerPinDialog } from '@features/manager-pin-gate';
import type { BankTransfer } from '@entities/bank-transfer';
import { isValidCode } from '@shared/lib/bank-transfer-code';
import { formatMoney } from '@shared/lib/format';
import { ConfirmDialog, Input, Label } from '@shared/ui';

import { useConfirmTransfer } from '../model/useConfirmTransfer';

export interface ConfirmTransferDialogProps {
  open: boolean;
  transfer: BankTransfer | null;
  onOpenChange: (open: boolean) => void;
}

export function ConfirmTransferDialog({ open, transfer, onOpenChange }: ConfirmTransferDialogProps) {
  const { t } = useTranslation('featOrders');
  const mutation = useConfirmTransfer();
  const [enteredCode, setEnteredCode] = useState('');
  const [pinOpen, setPinOpen] = useState(false);

  if (!transfer) return null;

  const codeValid = isValidCode(enteredCode);
  const showFormatError = enteredCode.length > 0 && !codeValid;

  function handleClose() {
    setEnteredCode('');
    setPinOpen(false);
    onOpenChange(false);
  }

  async function handlePinSuccess() {
    setPinOpen(false);
    if (!transfer) return;
    const result = await mutation.mutateAsync({ paymentId: transfer.paymentId, enteredCode });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(
      t('confirmDisputeTransfer.confirmSuccess', { amount: formatMoney(transfer.amount) })
    );
    handleClose();
  }

  return (
    <>
      <ConfirmDialog
        open={open && !pinOpen}
        title={t('confirmDisputeTransfer.confirmTitle')}
        description={t('confirmDisputeTransfer.confirmDescription', { name: transfer.customerName })}
        confirmLabel={t('confirmDisputeTransfer.confirmButton')}
        confirmDisabled={!codeValid}
        isLoading={mutation.isPending}
        onConfirm={() => {
          setPinOpen(true);
        }}
        onCancel={handleClose}
      >
        <div className="space-y-1.5">
          <Label htmlFor="confirm-transfer-code">{t('confirmDisputeTransfer.codeLabel')}</Label>
          <Input
            id="confirm-transfer-code"
            value={enteredCode}
            onChange={event => {
              setEnteredCode(event.target.value.replace(/\D/g, '').slice(0, 7));
            }}
            maxLength={7}
            inputMode="numeric"
            placeholder={t('confirmDisputeTransfer.codePlaceholder')}
          />
          {showFormatError && (
            <p className="text-xs text-destructive">{t('confirmDisputeTransfer.codeInvalid')}</p>
          )}
        </div>
      </ConfirmDialog>
      <ManagerPinDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        requiredAction="confirm_transfer_payment"
        onSuccess={() => {
          void handlePinSuccess();
        }}
      />
    </>
  );
}
