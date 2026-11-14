import { useCallback, useEffect } from 'react';
import { isOfflineOnly } from '../store-mode';
import { useStoreSchemaStore } from '../store-schema/store';
import { backendKey, fetchStoreSwitchState } from './client';
import { clearMovedFlag, useStoreSwitchStore, writeMovedFlag } from './store';
import type { StoreSwitchState } from './types';

export const POLL_ACTIVE_MS = 30_000;
export const POLL_BUSY_MS = 10_000;

/** Unknown (null) changes nothing. `moved` is remembered across restarts; any other answer releases the flag. leaving moved also resets the schema store. */
export function applyObserved(next: StoreSwitchState | null, key: string): void {
  if (next === null) return;
  const wasMoved = useStoreSwitchStore.getState().state === 'moved';
  useStoreSwitchStore.getState().setState(next);
  // Any exit from moved (active, or draining/frozen on a new switch) means the till faces a different store than the one
  // the cached schema verdict was read from. Offline-only probes at once so the wall does not wait for POLL_MS.
  if (wasMoved && next !== 'moved') {
    useStoreSchemaStore.getState().reset();
    if (isOfflineOnly()) void useStoreSchemaStore.getState().refresh();
  }
  if (next === 'moved') writeMovedFlag(key);
  else clearMovedFlag(key);
}

export function useStoreSwitchState(): { state: StoreSwitchState; recheck: () => Promise<void> } {
  const state = useStoreSwitchStore(s => s.state);

  const recheck = useCallback(async () => {
    applyObserved(await fetchStoreSwitchState(), backendKey());
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = backendKey();
    const tick = async (): Promise<void> => {
      applyObserved(await fetchStoreSwitchState(), key);
      if (cancelled) return;
      const busy = useStoreSwitchStore.getState().state !== 'active';
      timer = setTimeout(
        () => {
          void tick();
        },
        busy ? POLL_BUSY_MS : POLL_ACTIVE_MS
      );
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  return { state, recheck };
}
