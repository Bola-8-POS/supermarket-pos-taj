import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { FormField, Input, LoadingSpinner, POSButton } from '@shared/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useCorrectOpenUnit } from '../model/useCorrectOpenUnit';

export interface CorrectOpenUnitDialogProps {
  openUnitId: string;
  productName: string;
  currentCount: number;
  unitsPerPackage: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CorrectOpenUnitDialog({
  openUnitId,
  productName,
  currentCount,
  unitsPerPackage,
  open,
  onOpenChange,
}: CorrectOpenUnitDialogProps) {
  const { t } = useTranslation('featMgmt');
  const { correctUnit, isSaving } = useCorrectOpenUnit();
  const [countInput, setCountInput] = useState(String(currentCount));
  const [reason, setReason] = useState('');
  const [pinOpen, setPinOpen] = useState(false);

  const parsedCount = Number(countInput);
  // Mirrors the RPC's own 0..unitsPerPackage range check (27-04) — the client
  // bound exists to avoid a pointless round trip, not as the control.
  const countIsValid =
    countInput.trim() !== '' &&
    Number.isInteger(parsedCount) &&
    parsedCount >= 0 &&
    parsedCount <= unitsPerPackage;
  const trimmedReason = reason.trim();
  const canSubmit = countIsValid && trimmedReason.length > 0;

  function resetAndClose(nextOpen: boolean) {
    if (!nextOpen) {
      setCountInput(String(currentCount));
      setReason('');
      setPinOpen(false);
    }
    onOpenChange(nextOpen);
  }

  async function handlePinSuccess() {
    setPinOpen(false);
    const ok = await correctUnit({
      openUnitId,
      remainingCount: parsedCount,
      reason: trimmedReason,
      productName,
    });
    if (ok) {
      resetAndClose(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={resetAndClose}>
        <DialogContent className="max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>{t('correctOpenUnit.dialogTitle', { name: productName })}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <FormField
              label={t('correctOpenUnit.countLabel')}
              {...(countIsValid
                ? { hint: t('correctOpenUnit.countHint') }
                : { error: t('correctOpenUnit.countOutOfRangeError', { max: unitsPerPackage }) })}
            >
              <Input
                type="number"
                value={countInput}
                onChange={e => {
                  setCountInput(e.target.value);
                }}
              />
            </FormField>

            <FormField label={t('correctOpenUnit.reasonLabel')}>
              <Input
                value={reason}
                placeholder={t('correctOpenUnit.reasonPlaceholder')}
                onChange={e => {
                  setReason(e.target.value);
                }}
              />
            </FormField>
          </div>

          <div className="flex justify-end gap-2 border-t pt-4">
            <POSButton
              type="button"
              variant="outline"
              touchSize="default"
              onClick={() => {
                resetAndClose(false);
              }}
              disabled={isSaving}
            >
              {t('common:actions.cancel')}
            </POSButton>
            <POSButton
              type="button"
              touchSize="default"
              disabled={!canSubmit || isSaving}
              onClick={() => {
                setPinOpen(true);
              }}
            >
              {isSaving ? <LoadingSpinner className="mr-2 size-4" /> : null}
              {isSaving ? t('common:actions.saving') : t('correctOpenUnit.confirmButton')}
            </POSButton>
          </div>
        </DialogContent>
      </Dialog>

      <ManagerPinDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        requiredAction="adjust_inventory"
        onSuccess={() => {
          void handlePinSuccess();
        }}
      />
    </>
  );
}
