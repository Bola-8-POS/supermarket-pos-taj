import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { verifyStaffPin } from '@entities/staff/model/pinVerification';
import { useStaffList } from '@entities/staff/model/queries';
import type { Staff } from '@shared/lib/domain';
import { canAccess } from '@shared/lib/rbac';
import type { StaffAction } from '@shared/lib/rbac';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  PINKeypad,
} from '@shared/ui';

export interface ManagerPinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requiredAction: StaffAction;
  /**
   * Called with the matched staff member and the approval ticket the server
   * issued for this prompt; the override RPC consumes the ticket.
   */
  onSuccess: (staff: Staff, approvalId: string) => void;
}

export function ManagerPinDialog({
  open,
  onOpenChange,
  requiredAction,
  onSuccess,
}: ManagerPinDialogProps) {
  const { t } = useTranslation('featOrders');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: staffList, isIdleOrLoading } = useStaffList();

  // This dialog stays mounted across open/close cycles (every caller renders
  // it unconditionally, only toggling `open`), and a successful PIN entry
  // closes it via the parent setting `open` to false directly — Radix's
  // onOpenChange (handleOpenChange below) only fires on a user-driven close
  // (Escape/outside-click/Cancel), never on a programmatic `open` prop
  // change. Without this, `pin` stays at maxLength from the prior success,
  // so PINKeypad's `disabled={value.length >= maxLength}` permanently locks
  // every key the next time this same dialog instance reopens.
  //
  // Adjusted during render (react.dev's "Adjusting state when a prop
  // changes" pattern) rather than in a useEffect, so the reset lands in the
  // same commit as the prop change instead of triggering an extra render.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setPin('');
      setError('');
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setPin('');
      setError('');
    }
    onOpenChange(next);
  }

  const eligibleStaff = useMemo(
    () => (staffList ?? []).filter(s => canAccess(s.role, requiredAction)),
    [staffList, requiredAction]
  );

  async function handlePinComplete(enteredPin: string): Promise<void> {
    setBusy(true);
    try {
      const res = await verifyStaffPin(enteredPin, undefined, requiredAction);
      if (res.ok) {
        // The server already applies the role rule; this filter is a second guard.
        const match = eligibleStaff.find(s => res.matches.some(m => m.id === s.id));
        if (match && typeof res.approvalId === 'string') {
          onSuccess(match, res.approvalId);
          return;
        }
        setError(t('managerPinGate.incorrectPin'));
      } else if (res.code === 'LOCKED' || (res.code === 'INVALID_PIN' && res.retryAfter > 0)) {
        setError(t('managerPinGate.lockedOut', { seconds: res.retryAfter }));
      } else if (res.code === 'UNAVAILABLE') {
        setError(t('managerPinGate.needsConnection'));
      } else {
        setError(t('managerPinGate.incorrectPin'));
      }
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('managerPinGate.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('managerPinGate.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <PINKeypad
          value={pin}
          onChange={setPin}
          onComplete={p => {
            void handlePinComplete(p);
          }}
          label={t('managerPinGate.pinLabel')}
          error={error}
          isLoading={isIdleOrLoading || busy}
        />

        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
