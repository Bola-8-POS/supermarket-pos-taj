import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { approveOffline, availableOfflineGrants } from '@entities/staff/model/offlineApproval';
import { verifyStaffPin } from '@entities/staff/model/pinVerification';
import { useStaffList } from '@entities/staff/model/queries';
import { useStaffStore } from '@entities/staff/model/store';
import { isOnline, useOnlineStatus } from '@shared/lib/connectivity';
import type { Staff } from '@shared/lib/domain';
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
   * issued for this prompt; the override RPC consumes the ticket. Offline, it
   * is the manager who issued the redeemed pre-approval and that grant's id,
   * which the same RPCs accept in place of a ticket.
   */
  onSuccess: (staff: Staff, approvalId: string) => void;
  /**
   * Opt in only where the action this gate unlocks can still complete with
   * no connection (e.g. it is queued for replay). Offline, such a gate
   * redeems a manager pre-approval; every other gate keeps saying it needs a
   * connection, so no pre-approval is spent on an action that would fail.
   */
  offlineCapable?: boolean;
  /**
   * What exactly this PIN approves, in plain words. Given, it is shown prominently in place of the
   * generic "to access this section" sentence, so a cashier cannot call a manager over for
   * "a stock PIN" while the approval runs a write-off. Absent: today's text.
   */
  description?: string;
}

export function ManagerPinDialog({
  open,
  onOpenChange,
  requiredAction,
  onSuccess,
  offlineCapable = false,
  description,
}: ManagerPinDialogProps) {
  const { t } = useTranslation('featOrders');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: staffList, isIdleOrLoading } = useStaffList();
  // "Offline mode" for this dialog: no connection, and the gated action can still complete.
  const offlineMode = !useOnlineStatus() && offlineCapable;
  // Offline the staff list may never load, and the offline path does not need it.
  const offlineGrantsLeft = offlineMode ? availableOfflineGrants(requiredAction).length : 0;

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

  /**
   * No server: redeem one of the manager pre-approvals issued to this terminal,
   * confirmed by the signed-in staff member's own PIN (offlineApproval.ts).
   */
  async function approveWithoutServer(enteredPin: string): Promise<void> {
    const offline = await approveOffline(requiredAction, enteredPin);
    if (offline.ok) {
      const issuer =
        (staffList ?? []).find(s => s.id === offline.approval.grantedBy) ?? useStaffStore.getState().currentStaff;
      if (issuer) {
        toast.success(t('managerPinGate.approvedOffline'));
        onSuccess(issuer, offline.approval.grantId);
        return;
      }
      setError(t('managerPinGate.needsConnection'));
    } else if (offline.reason === 'no_grant') {
      setError(t('managerPinGate.offlineNoGrant'));
    } else if (offline.retryAfterMs > 0) {
      setError(t('managerPinGate.lockedOut', { seconds: Math.ceil(offline.retryAfterMs / 1000) }));
    } else if (offline.reason === 'wrong_pin') {
      setError(t('managerPinGate.offlineWrongPin'));
    } else {
      setError(t('managerPinGate.needsConnection'));
    }
    setPin('');
  }

  async function handlePinComplete(enteredPin: string): Promise<void> {
    setBusy(true);
    try {
      const res = isOnline()
        ? await verifyStaffPin(enteredPin, undefined, requiredAction)
        : ({ ok: false, code: 'UNAVAILABLE', retryAfter: 0 } as const);
      if (res.ok) {
        // verify_staff_pin's own role_permissions EXISTS clause is the sole
        // eligibility check now — matched directly against the roster, not
        // filtered again by a client-side copy of the rule.
        const match = (staffList ?? []).find(s => res.matches.some(m => m.id === s.id));
        if (match && typeof res.approvalId === 'string') {
          onSuccess(match, res.approvalId);
          return;
        }
        setError(t('managerPinGate.incorrectPin'));
      } else if (res.code === 'LOCKED' || (res.code === 'INVALID_PIN' && res.retryAfter > 0)) {
        setError(t('managerPinGate.lockedOut', { seconds: res.retryAfter }));
      } else if (res.code === 'UNAVAILABLE' && offlineCapable) {
        await approveWithoutServer(enteredPin);
        return;
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
          <AlertDialogDescription
            {...(description === undefined
              ? {}
              : // eslint-disable-next-line i18next/no-literal-string -- test id and class names, not UI copy
                { 'data-testid': 'pin-gate-description', className: 'text-base font-semibold text-foreground' })}
          >
            {description ??
              (offlineMode
                ? t('managerPinGate.offlineDescription', { count: offlineGrantsLeft })
                : t('managerPinGate.description'))}
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
          isLoading={(!offlineMode && isIdleOrLoading) || busy}
        />

        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
