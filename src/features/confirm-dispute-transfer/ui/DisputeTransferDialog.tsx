/**
 * DisputeTransferDialog — two-step gate for disputing a pending bank
 * transfer: reason entry -> manager PIN -> dispute_transfer_payment mutation.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ManagerPinDialog } from '@features/manager-pin-gate';
import type { BankTransfer } from '@entities/bank-transfer';
import { ConfirmDialog, Label } from '@shared/ui';
import { Textarea } from '@shared/ui/textarea';

import { useDisputeTransfer } from '../model/useDisputeTransfer';

export interface DisputeTransferDialogProps {
  open: boolean;
  transfer: BankTransfer | null;
  onOpenChange: (open: boolean) => void;
}

export function DisputeTransferDialog({ open, transfer, onOpenChange }: DisputeTransferDialogProps) {
  const { t } = useTranslation('featOrders');
  const mutation = useDisputeTransfer();
  const [reason, setReason] = useState('');
  const [pinOpen, setPinOpen] = useState(false);

  if (!transfer) return null;

  const trimmedReason = reason.trim();
  const canConfirm = trimmedReason.length > 0;

  function handleClose() {
    setReason('');
    setPinOpen(false);
    onOpenChange(false);
  }

  async function handlePinSuccess() {
    setPinOpen(false);
    if (!transfer) return;
    const result = await mutation.mutateAsync({ paymentId: transfer.paymentId, reason: trimmedReason });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(t('confirmDisputeTransfer.disputeSuccess'));
    handleClose();
  }

  return (
    <>
      <ConfirmDialog
        open={open && !pinOpen}
        title={t('confirmDisputeTransfer.disputeTitle')}
        description={t('confirmDisputeTransfer.disputeDescription', { name: transfer.customerName })}
        confirmLabel={t('confirmDisputeTransfer.disputeButton')}
        variant="destructive"
        confirmDisabled={!canConfirm}
        isLoading={mutation.isPending}
        onConfirm={() => {
          setPinOpen(true);
        }}
        onCancel={handleClose}
      >
        <div className="space-y-1.5">
          <Label htmlFor="dispute-transfer-reason">{t('confirmDisputeTransfer.reasonLabel')}</Label>
          <Textarea
            id="dispute-transfer-reason"
            value={reason}
            onChange={event => {
              setReason(event.target.value);
            }}
            placeholder={t('confirmDisputeTransfer.reasonPlaceholder')}
            maxLength={200}
          />
        </div>
      </ConfirmDialog>
      <ManagerPinDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        requiredAction="dispute_transfer_payment"
        onSuccess={() => {
          void handlePinSuccess();
        }}
      />
    </>
  );
}
