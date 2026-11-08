import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import type { Staff } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { LockedFeature } from '@shared/ui/LockedFeature';
import { POSButton } from '@shared/ui/POSButton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { useDeactivateStaff } from '../model/useDeactivateStaff';

export type DeactivateStaffDialogProps = {
  staff: Staff | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function DeactivateStaffDialog({ staff, open, onOpenChange }: DeactivateStaffDialogProps) {
  const { t } = useTranslation('staff');
  const [confirmGateOpen, setConfirmGateOpen] = useState(false);
  const mutation = useDeactivateStaff();

  function handleOpenChange(next: boolean) {
    if (!next) setConfirmGateOpen(false);
    onOpenChange(next);
  }

  async function handleConfirmedDeactivate() {
    if (!staff) return;

    const result = await mutation.mutateAsync({ staffId: staff.id });

    // The gate does not close itself; close it before reporting the outcome
    // so a refusal never leaves it open with a filled keypad.
    setConfirmGateOpen(false);

    if (!result.ok) {
      logger.error('deactivate-staff.submit.failed', { message: result.error.message });
      if (result.error.code === 'STAFF_LAST_ADMIN') {
        toast.error(t('deactivate.lastAdmin'));
      } else if (result.error.code === 'STAFF_DEACTIVATE_PARTIAL_FAILURE') {
        toast.error(t('deactivate.partialFailureToast'));
      } else {
        toast.error(t('deactivate.genericFailure'));
      }
      return;
    }

    toast.success(t('deactivate.successToast', { name: staff.name }));
    setConfirmGateOpen(false);
    handleOpenChange(false);
  }

  const name = staff?.name ?? '';

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-semibold">
              {t('deactivate.dialogTitle', { name })}
            </DialogTitle>
            <DialogDescription>{t('deactivate.dialogDescription', { name })}</DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <POSButton
              type="button"
              variant="outline"
              touchSize="default"
              onClick={() => {
                handleOpenChange(false);
              }}
              disabled={mutation.isPending}
            >
              {t('common:actions.cancel')}
            </POSButton>
            <LockedFeature feature="staff_management">
              <POSButton
                type="button"
                variant="destructive"
                touchSize="default"
                onClick={() => {
                  setConfirmGateOpen(true);
                }}
                disabled={!staff || mutation.isPending}
              >
                {mutation.isPending ? t('deactivate.confirming') : t('deactivate.confirm')}
              </POSButton>
            </LockedFeature>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerPinDialog
        open={confirmGateOpen}
        onOpenChange={setConfirmGateOpen}
        requiredAction="manage_staff"
        onSuccess={() => {
          void handleConfirmedDeactivate();
        }}
      />
    </>
  );
}
