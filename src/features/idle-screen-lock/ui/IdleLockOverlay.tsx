import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { checkOfflineUnlock } from '@entities/staff/model/offlineUnlock';
import { verifyStaffPin } from '@entities/staff/model/pinVerification';
import { useStaffList } from '@entities/staff/model/queries';
import { useStaffStore } from '@entities/staff/model/store';
import { isOnline } from '@shared/lib/connectivity';
import type { Staff } from '@shared/lib/domain';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  PINKeypad,
} from '@shared/ui';

export interface IdleLockOverlayProps {
  open: boolean;
  onUnlock: (staff: Staff) => void;
}

/**
 * Non-dismissable PIN-entry overlay shown while the terminal is idle-locked
 * (LCK-01). Modeled on ManagerPinDialog, minus two deliberate removals:
 *  - No role filter on candidate staff (D-04: ANY valid staff PIN unlocks).
 *  - No AlertDialogFooter/Cancel -- only a correct PIN closes this dialog.
 *    Escape is explicitly prevented below; Radix's AlertDialogContent
 *    already blocks outside-pointer dismissal by design.
 *
 * The PIN is checked on the server (verifyStaffPin). This handler MUST
 * NEVER call a Supabase Auth sign-in/update method, or a cross-staff unlock
 * would swap the active auth session (D-04). Offline, only the signed-in
 * staff member can unlock, against the in-memory check set at sign-in.
 */
export function IdleLockOverlay({ open, onUnlock }: IdleLockOverlayProps) {
  const { t } = useTranslation('featOrders');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: staffList, isIdleOrLoading } = useStaffList();

  // Same render-time-reset pattern as ManagerPinDialog: this overlay stays
  // mounted across lock/unlock cycles (IdleLockProvider only toggles `open`),
  // so `pin`/`error` must clear every time `open` flips back to true or a
  // stale maxLength-reached `pin` would permanently disable every key.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setPin('');
      setError('');
    }
  }

  async function handlePinComplete(enteredPin: string): Promise<void> {
    setBusy(true);
    try {
      const res = isOnline()
        ? await verifyStaffPin(enteredPin)
        : ({ ok: false, code: 'UNAVAILABLE', retryAfter: 0 } as const);

      if (res.ok) {
        const match = (staffList ?? []).find(s => res.matches.some(m => m.id === s.id));
        if (match) {
          setPin('');
          setError('');
          onUnlock(match);
          return;
        }
        setError(t('idleLock.incorrectPin'));
      } else if (res.code === 'UNAVAILABLE') {
        const me = useStaffStore.getState().currentStaff;
        const offline = me ? await checkOfflineUnlock(me.id, enteredPin) : ({ ok: false, retryAfter: 0 } as const);
        if (offline.ok && me) {
          setPin('');
          setError('');
          onUnlock(me);
          return;
        }
        setError(
          !offline.ok && offline.retryAfter > 0
            ? t('idleLock.lockedOut', { seconds: offline.retryAfter })
            : t('idleLock.offlineOnlySameUser')
        );
      } else if (res.code === 'LOCKED' || res.retryAfter > 0) {
        // Only 'INVALID_PIN' and 'LOCKED' remain here ('UNAVAILABLE' is
        // handled above), so a positive retryAfter means a match just armed
        // the lock on this same call.
        setError(t('idleLock.lockedOut', { seconds: res.retryAfter }));
      } else {
        setError(t('idleLock.incorrectPin'));
      }
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={() => undefined}>
      <AlertDialogContent
        onEscapeKeyDown={e => {
          e.preventDefault();
        }}
      >
        {/* Radix's AlertDialogContent (unlike Dialog) already prevents
            outside-pointer dismissal by design -- only Escape needs an
            explicit preventDefault here. No AlertDialogCancel/Footer --
            only a correct PIN closes this dialog. */}
        <AlertDialogHeader>
          <AlertDialogTitle>{t('idleLock.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('idleLock.description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <PINKeypad
          value={pin}
          onChange={setPin}
          onComplete={p => {
            void handlePinComplete(p);
          }}
          error={error}
          isLoading={isIdleOrLoading || busy}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}
