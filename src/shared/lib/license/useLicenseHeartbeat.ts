import { useEffect } from 'react';
import { isOnline } from '@shared/lib/connectivity';
import { revalidateStoredToken, runHeartbeat } from './actions';
import { HEARTBEAT_INTERVAL_MS, isLicenseEnforced } from './config';
import { OFFLINE_TICK_MS } from './offline-budget';
import { currentLicenseEvaluation, requiresRevalidation, useLicenseStore } from './store';

/**
 * Mount once (app providers). Re-verifies the stored token, then refreshes the lease on
 * startup, every 6 h, and whenever the network comes back. No-op when enforcement is off.
 */
export function useLicenseHeartbeat(): void {
  useEffect(() => {
    if (!isLicenseEnforced()) return;
    useLicenseStore.getState().touchClock();
    void revalidateStoredToken().then(runHeartbeat);

    const interval = setInterval(() => {
      useLicenseStore.getState().touchClock();
      void runHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    // The only offline-budget ticker: this hook mounts once, whereas useLicenseEvaluation has
    // several instances and each would credit a frozen-clock tick again.
    const budgetTick = setInterval(() => {
      useLicenseStore.getState().accrueOfflineRuntime();
      // Sales are held until one heartbeat succeeds (revalidation, or restricted), so retry every
      // tick instead of every 6 h — the WAN can come back without an 'online' event on a live LAN.
      const held = requiresRevalidation() || currentLicenseEvaluation().state === 'restricted';
      if (held && isOnline()) void runHeartbeat();
    }, OFFLINE_TICK_MS);
    const onOnline = () => {
      void runHeartbeat();
    };
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(interval);
      clearInterval(budgetTick);
      window.removeEventListener('online', onOnline);
    };
  }, []);
}
