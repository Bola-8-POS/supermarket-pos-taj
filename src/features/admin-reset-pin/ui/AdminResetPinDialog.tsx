import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ManagerPinDialog } from '@features/manager-pin-gate';
import { findStaffPinHolder } from '@entities/staff/model/pinVerification';
import { PinSchema, type Staff } from '@shared/lib/domain';
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
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { useAdminResetPin } from '../model/useAdminResetPin';

export type AdminResetPinDialogProps = {
  staff: Staff | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AdminResetPinDialog({ staff, open, onOpenChange }: AdminResetPinDialogProps) {
  const { t } = useTranslation('staff');

  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');
  const [confirmGateOpen, setConfirmGateOpen] = useState(false);

  const mutation = useAdminResetPin();

  function resetForm() {
    setNewPin('');
    setConfirmNewPin('');
    setConfirmGateOpen(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetForm();
    onOpenChange(next);
  }

  const canSubmit =
    PinSchema.safeParse(newPin).success &&
    PinSchema.safeParse(confirmNewPin).success &&
    newPin === confirmNewPin &&
    !mutation.isPending;

  // D-07: warn on a collision with another ACTIVE staff member's current
  // PIN, excluding the target's own row — findStaffPinHolder is already
  // is_active-filtered on the server, so inactive staff never appear here.
  const pinComplete = PinSchema.safeParse(newPin).success;
  const { data: collisionName } = useQuery({
    // The PIN is part of the key only in memory and is dropped at once (gcTime 0).
    // eslint-disable-next-line i18next/no-literal-string -- query-key namespace strings, not UI copy.
    queryKey: ['staff', 'pinHolder', staff?.id ?? null, newPin],
    queryFn: () => findStaffPinHolder(newPin, staff?.id),
    enabled: open && pinComplete,
    gcTime: 0,
    staleTime: 0,
  });

  function handleSubmitClick() {
    if (!canSubmit) return;
    setConfirmGateOpen(true);
  }

  async function handleConfirmedReset() {
    if (!staff) return;

    const result = await mutation.mutateAsync({ targetStaffId: staff.id, newPin });

    if (!result.ok) {
      logger.error('admin-reset-pin.submit.failed', { message: result.error.message });
      if (result.error.code === 'PIN_RESET_PARTIAL_FAILURE') {
        toast.error(t('resetPin.partialFailureToast'));
      } else {
        toast.error(t('resetPin.genericFailure'));
      }
      return;
    }

    toast.success(t('resetPin.successToast', { name: staff.name }));
    setConfirmGateOpen(false);
    handleOpenChange(false);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-semibold">
              {t('resetPin.dialogTitle', { name: staff?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('resetPin.dialogDescription')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="admin-reset-pin-new" className="font-normal">
                {t('resetPin.newPinLabel')}
              </Label>
              <Input
                id="admin-reset-pin-new"
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={newPin}
                onChange={e => {
                  setNewPin(e.target.value);
                }}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="admin-reset-pin-confirm" className="font-normal">
                {t('resetPin.confirmPinLabel')}
              </Label>
              <Input
                id="admin-reset-pin-confirm"
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={confirmNewPin}
                onChange={e => {
                  setConfirmNewPin(e.target.value);
                }}
              />
              {collisionName && newPin.length === 6 && (
                <p className="text-sm text-muted-foreground">
                  {t('resetPin.collisionWarning', { name: collisionName })}
                </p>
              )}
            </div>
          </div>

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
                touchSize="default"
                onClick={handleSubmitClick}
                disabled={!canSubmit}
              >
                {mutation.isPending ? t('resetPin.submitting') : t('resetPin.submit')}
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
          void handleConfirmedReset();
        }}
      />
    </>
  );
}
