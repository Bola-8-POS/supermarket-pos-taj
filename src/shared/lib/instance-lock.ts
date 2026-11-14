import { useSyncExternalStore } from 'react';
import { logger } from './logger-instance';
/* eslint-disable i18next/no-literal-string -- lock name and log events, not UI copy. */

/**
 * Which running copy of the app owns the offline-sale store. Every copy of the app in one webview
 * profile (a second app process, a browser tab) shares `localStorage`, and each store write
 * replaces the whole `offline-sales` key from that copy's own memory, so a stale copy would erase
 * sales the other one stored. Exactly one copy is `primary` (it holds a Web Lock for its whole
 * life); the others are `secondary` and neither sell offline, replay nor resolve (two-mode Plan
 * 02b, F3 / Ruling R46: degrade, never block the app).
 *
 * - `unknown`: the request has not settled (it does so in the first tick). Not yet eligible.
 * - `primary`: the lock was granted, or `navigator.locks` is missing (nothing to coordinate with).
 * - `secondary`: another copy holds the lock.
 */
export type InstanceRole = 'unknown' | 'primary' | 'secondary';

const LOCK_NAME = 'pos-offline-sales-primary';

let role: InstanceRole = 'unknown';
let requested = false;
const listeners = new Set<() => void>();

function setRole(next: InstanceRole): void {
  if (role === next) return;
  role = next;
  listeners.forEach(listener => {
    listener();
  });
}

export const getInstanceRole = (): InstanceRole => role;

export function subscribeInstanceRole(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The role, re-rendering when it settles. */
export const useInstanceRole = (): InstanceRole =>
  useSyncExternalStore(subscribeInstanceRole, getInstanceRole, getInstanceRole);

/**
 * Asks for the lock, once per document. Called at module load below, NOT from a React effect: a
 * second request from the same document would be refused by its own first one and demote it.
 */
export function requestInstanceLock(): void {
  if (requested) return;
  requested = true;
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    setRole('primary');
    return;
  }
  try {
    void locks
      .request(LOCK_NAME, { ifAvailable: true }, lock => {
        if (lock === null) {
          setRole('secondary');
          return undefined;
        }
        setRole('primary');
        // never settles: the lock is held until this document goes away
        return new Promise<never>(() => undefined);
      })
      .catch((e: unknown) => {
        logger.warn('instance_lock.request_failed', { error: e });
        if (role === 'unknown') setRole('primary');
      });
  } catch (e) {
    logger.warn('instance_lock.request_threw', { error: e });
    setRole('primary');
  }
}

// The product peek window (`/?window=peek`, see main.tsx) never sells or replays, and asking would
// make it the primary instead of the main window.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('window') !== 'peek') {
  requestInstanceLock();
}
