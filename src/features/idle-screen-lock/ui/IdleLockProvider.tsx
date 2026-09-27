import { useCallback, useEffect, type ReactNode } from 'react';

import { useTerminalLockSettings } from '@entities/settings';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { useLockStateStore } from '@shared/lib/lock-state-store';
import { useIdleLockAudit } from '../model/useIdleLockAudit';
import { useIdleTimer } from '../model/useIdleTimer';
import { IdleLockOverlay } from './IdleLockOverlay';

const DEFAULT_LOCK_TIMEOUT_SECONDS = 60;

export interface IdleLockProviderProps {
  children: ReactNode;
}

/**
 * Mounted in App.tsx between ClockDriftBanner and Router. `children` is
 * ALWAYS rendered (D-01: the wrapped route's state -- cart, payment modal,
 * any in-progress dialog -- is never unmounted); the overlay paints on top
 * only while locked.
 */
export function IdleLockProvider({ children }: IdleLockProviderProps) {
  const isAuthenticated = useStaffStore(s => s.isAuthenticated);
  const currentStaff = useStaffStore(s => s.currentStaff);
  const currentShift = useStaffStore(s => s.currentShift);
  const hasHydrated = useStaffStore(s => s.hasHydrated);
  const { data: lockSettings } = useTerminalLockSettings();
  const { recordLock, recordUnlock } = useIdleLockAudit();
  const locked = useLockStateStore(s => s.locked);

  // A stale persisted lock must never trap a fresh login: no authenticated
  // staff ⇒ nothing is locked. Gated on hasHydrated because isAuthenticated is
  // false for one microtask before the staff store rehydrates.
  useEffect(() => {
    if (hasHydrated && !isAuthenticated) {
      useLockStateStore.getState().setLocked(false);
    }
  }, [hasHydrated, isAuthenticated]);

  const timeoutMs = (lockSettings?.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS) * 1000;

  const handleIdle = useCallback(() => {
    useLockStateStore.getState().setLocked(true);
    void recordLock(currentStaff, currentShift?.id ?? null);
  }, [currentStaff, currentShift, recordLock]);

  const handleUnlock = useCallback(
    (matchedStaff: Staff) => {
      useLockStateStore.getState().setLocked(false);
      void recordUnlock(currentStaff, matchedStaff, currentShift?.id ?? null);
    },
    [currentStaff, currentShift, recordUnlock]
  );

  // Pitfall 4: fully paused (not merely ignored) while `locked` is true, so
  // PIN-entry keystrokes on the overlay never reset the "time until re-lock"
  // countdown. Restarts fresh the instant a successful unlock flips `locked`
  // back to false.
  useIdleTimer(timeoutMs, handleIdle, isAuthenticated && !locked);

  return (
    <>
      {children}
      {isAuthenticated && <IdleLockOverlay open={locked} onUnlock={handleUnlock} />}
    </>
  );
}
