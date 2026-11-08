import { create } from 'zustand';
import type { StoreSwitchState } from './types';

interface StoreSwitchStore {
  state: StoreSwitchState;
  setState: (state: StoreSwitchState) => void;
}

/** What this till last learned about the cloud store. Unknown never changes it (fail open at boot, sticky after). */
export const useStoreSwitchStore = create<StoreSwitchStore>()(set => ({
  state: 'active',
  setState: state => {
    set({ state });
  },
}));

export function currentStoreSwitchState(): StoreSwitchState {
  return useStoreSwitchStore.getState().state;
}

const MOVED_PREFIX = 'pos.store_moved:';

/** Keyed by backend: a till paired to another server does not inherit the flag. */
export function movedFlagKey(backend: string): string {
  return `${MOVED_PREFIX}${backend}`;
}

export function readMovedFlag(backend: string): boolean {
  try {
    return localStorage.getItem(movedFlagKey(backend)) === '1';
  } catch {
    return false; // ponytail: storage unavailable; the flag then lives in memory only
  }
}

export function writeMovedFlag(backend: string): void {
  try {
    localStorage.setItem(movedFlagKey(backend), '1');
  } catch {
    /* ponytail: see readMovedFlag */
  }
}

export function clearMovedFlag(backend: string): void {
  try {
    localStorage.removeItem(movedFlagKey(backend));
  } catch {
    /* ponytail: see readMovedFlag */
  }
}
