import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { verifyStaffPin } from '@entities/staff/model/pinVerification';
import { useMutationClockIn } from '@entities/staff/model/queries';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { ConfirmDialog, MoneyInput, PINKeypad } from '@shared/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';

type Phase = 'pin' | 'opening_cash';

export type ClockInModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Staff member clocking in (must not already have an open shift). */
  staff: Staff | null;
};

export function ClockInModal({ open, onOpenChange, staff }: ClockInModalProps) {
  const { t } = useTranslation('featMgmt');
  const [phase, setPhase] = useState<Phase>('pin');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [openingCash, setOpeningCash] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);

  const clockIn = useMutationClockIn();
  const currentStaffId = useStaffStore(s => s.currentStaff?.id);

  useEffect(() => {
    if (!open) {
      setPhase('pin');
      setPin('');
      setPinError('');
      setOpeningCash(0);
      setBusy(false);
      setPinBusy(false);
    }
  }, [open]);

  if (!staff) return null;

  const handlePinComplete = async (entered: string): Promise<void> => {
    setPinBusy(true);
    try {
      const res = await verifyStaffPin(entered, staff.id);
      if (res.ok) {
        setPhase('opening_cash');
        setOpeningCash(0);
        return;
      }
      if (res.code === 'LOCKED' || (res.code === 'INVALID_PIN' && res.retryAfter > 0)) {
        setPinError(t('clockInStaff.lockedOut', { seconds: res.retryAfter }));
      } else if (res.code === 'UNAVAILABLE') {
        setPinError(t('clockInStaff.needsConnection'));
      } else {
        setPinError(t('clockInStaff.incorrectPin'));
      }
      setPin('');
    } finally {
      setPinBusy(false);
    }
  };

  const handleOpeningConfirm = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await clockIn.mutateAsync({ staffId: staff.id, openingCash });
      if (!result.ok) {
        logger.error('clock_in_modal.failed', { message: result.error.message });
        toast.error(result.error.message);
        return;
      }
      if (currentStaffId === staff.id) {
        useStaffStore.getState().login(staff, result.data);
      }
      toast.success(t('clockInStaff.clockedIn', { name: staff.name }));
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('clockInStaff.dialogTitle')}</DialogTitle>
          <DialogDescription>
            {t('clockInStaff.dialogDescription', { name: staff.name })}
          </DialogDescription>
        </DialogHeader>

        {phase === 'pin' && (
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="flex size-14 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
              {staff.name.charAt(0).toUpperCase()}
            </div>
            <PINKeypad
              value={pin}
              onChange={v => {
                setPin(v);
                if (pinError) setPinError('');
              }}
              onComplete={p => {
                void handlePinComplete(p);
              }}
              label={t('clockInStaff.enterPinLabel')}
              error={pinError}
              isLoading={pinBusy}
            />
          </div>
        )}

        <ConfirmDialog
          open={phase === 'opening_cash'}
          title={t('clockInStaff.openingCashTitle')}
          description={t('clockInStaff.openingCashDescription')}
          confirmLabel={t('clockInStaff.startShift')}
          cancelLabel={t('clockInStaff.back')}
          onConfirm={() => {
            void handleOpeningConfirm();
          }}
          onCancel={() => {
            setPhase('pin');
            setPin('');
          }}
          isLoading={busy}
          confirmDisabled={busy}
        >
          <div className="py-4">
            <MoneyInput
              label={t('clockInStaff.drawerFloatLabel')}
              value={openingCash}
              onChange={setOpeningCash}
              disabled={busy}
              placeholder="0.00"
            />
          </div>
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}
