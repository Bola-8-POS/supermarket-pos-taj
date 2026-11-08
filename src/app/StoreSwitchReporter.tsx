import { useEffect } from 'react';
import { useOfflineSaleStore } from '@entities/offline-sale/model/store';
import { useStaffStore } from '@entities/staff/model/store';
import { useTabStore } from '@entities/tab/model/store';
import { useOnlineStatus } from '@shared/lib/connectivity';
import { backendKey, reportTillSync } from '@shared/lib/store-switch/client';
import { useStoreSwitchStore } from '@shared/lib/store-switch/store';
import { applyObserved } from '@shared/lib/store-switch/useStoreSwitchState';

export const REPORT_IDLE_MS = 300_000;
export const REPORT_BUSY_MS = 10_000;

/**
 * Tells the cloud how much unsynced offline work this till holds, so `posctl switch` can drain the tills before it
 * freezes the store. Every 5 minutes while the store is normal, at once whenever the queue or the state changes,
 * and every 10 s while a switch is in progress. Signed-in and online only: replay needs both anyway.
 */
export function StoreSwitchReporter(): null {
  const isAuthenticated = useStaffStore(s => s.isAuthenticated);
  const online = useOnlineStatus();
  // A needs_review sale counts once, as a dead letter: it waits for a manager, not for the till to sync.
  // Offline sales live in their own store (two-mode 02b), not in the tab queue: the drain has to wait for them too.
  const queueDepth =
    useTabStore(s => s.offlineQueue.length) + useOfflineSaleStore(s => s.records.filter(x => x.status === 'queued' || x.status === 'replaying').length);
  const deadLetterDepth =
    useTabStore(s => s.deadLetterQueue.length) +
    useOfflineSaleStore(s => s.records.filter(x => x.status === 'needs_review').length);
  const state = useStoreSwitchStore(s => s.state);

  useEffect(() => {
    if (!isAuthenticated || !online || state === 'moved') return undefined;
    let cancelled = false;
    const send = async (): Promise<void> => {
      const next = await reportTillSync({ queueDepth, deadLetterDepth, seenState: state });
      if (!cancelled) applyObserved(next, backendKey());
    };
    void send();
    const id = window.setInterval(
      () => {
        void send();
      },
      state === 'active' ? REPORT_IDLE_MS : REPORT_BUSY_MS
    );
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isAuthenticated, online, queueDepth, deadLetterDepth, state]);

  return null;
}
