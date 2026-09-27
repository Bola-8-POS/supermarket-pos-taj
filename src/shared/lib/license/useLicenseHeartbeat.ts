import { useEffect } from 'react';
import { revalidateStoredToken, runHeartbeat } from './actions';
import { HEARTBEAT_INTERVAL_MS, isLicenseEnforced } from './config';
import { useLicenseStore } from './store';

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
    const onOnline = () => {
      void runHeartbeat();
    };
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', onOnline);
    };
  }, []);
}
