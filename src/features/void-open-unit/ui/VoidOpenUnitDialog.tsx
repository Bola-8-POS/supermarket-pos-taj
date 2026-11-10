import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { FormField, Input, LoadingSpinner, POSButton } from '@shared/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { useVoidOpenUnit } from '../model/useVoidOpenUnit';

export interface VoidOpenUnitDialogProps {
  openUnitId: string;
  productName: string;
  currentCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// D-10: voiding abandons an already-opened package — inventory is NOT
// credited back by the RPC, so this dialog deliberately offers no control
// that would imply the package returns to stock.
export function VoidOpenUnitDialog({
  openUnitId,
  productName,
  currentCount,
  open,
  onOpenChange,
}: VoidOpenUnitDialogProps) {
  const { t } = useTranslation('featMgmt');
  const { voidUnit, isSaving } = useVoidOpenUnit();
  const [reason, setReason] = useState('');
  const [pinOpen, setPinOpen] = useState(false);

  const trimmedReason = reason.trim();
  const canSubmit = trimmedReason.length > 0;

  function resetAndClose(nextOpen: boolean) {
    if (!nextOpen) {
      setReason('');
      setPinOpen(false);
    }
    onOpenChange(nextOpen);
  }

  async function handlePinSuccess() {
    setPinOpen(false);
    const ok = await voidUnit({ openUnitId, reason: trimmedReason, productName });
    if (ok) {
      resetAndClose(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={resetAndClose}>
        <DialogContent className="max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>{t('voidOpenUnit.dialogTitle', { name: productName })}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('voidOpenUnit.confirmationBody', { count: currentCount })}
            </p>

            <FormField label={t('voidOpenUnit.reasonLabel')}>
              <Input
                value={reason}
                placeholder={t('voidOpenUnit.reasonPlaceholder')}
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
              variant="destructive"
              touchSize="default"
              disabled={!canSubmit || isSaving}
              onClick={() => {
                setPinOpen(true);
              }}
            >
              {isSaving ? <LoadingSpinner className="mr-2 size-4" /> : null}
              {isSaving ? t('common:actions.saving') : t('voidOpenUnit.confirmButton')}
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
