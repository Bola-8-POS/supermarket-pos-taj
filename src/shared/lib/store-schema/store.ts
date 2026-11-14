import { useEffect } from 'react';
import { create } from 'zustand';
import { logger } from '../logger-instance';
import { isOfflineOnly } from '../store-mode';
import { isBlocking, type StoreSchemaState } from './classify';
import { probeStoreSchema } from './probe';

// store.ts imports connectivity.ts (via probe.ts) and store-mode.ts, never supabase.ts: no import cycle.

export const POLL_MS = 30_000;
export const POLL_FAST_MS = 5_000;

interface StoreSchemaStore {
  state: StoreSchemaState;
  /** Epoch ms of the last completed probe; 0 = never. */
  checkedAt: number;
  refresh: () => Promise<StoreSchemaState>;
  /** Back to the initial (unreachable, never probed) state; a probe still in flight for the old store is dropped. */
  reset: () => void;
}

let inFlight: Promise<StoreSchemaState> | null = null;
let generation = 0;

const INITIAL = { state: { kind: 'unreachable' }, checkedAt: 0 } as const;

export const useStoreSchemaStore = create<StoreSchemaStore>((set, get) => ({
  ...INITIAL,
  reset: () => {
    generation += 1;
    inFlight = null;
    set(INITIAL);
  },
  refresh: () => {
    const gen = generation;
    inFlight ??= probeStoreSchema()
      .then((next) => {
        if (gen !== generation) return get().refresh(); // the store changed under this probe: its answer is stale, and callers (the write guard) must get a real verdict, not the reset placeholder
        const prev = get().state;
        // A blip must not unblock: keep a blocking verdict through an unreachable probe.
        const kept = next.kind === 'unreachable' && isBlocking(prev) ? prev : next;
        if (kept.kind !== prev.kind) logger.info('store_schema.verdict', { from: prev.kind, to: kept.kind });
        set({ state: kept, checkedAt: Date.now() });
        return kept;
      })
      .finally(() => {
        if (gen === generation) inFlight = null;
      });
    return inFlight;
  },
}));

/** Polls the store's schema level. Offline-only mode only; in cloud mode the body does nothing. */
export function useStoreSchemaPolling(): void {
  const fast = useStoreSchemaStore((s) => s.state.kind === 'updating' || isBlocking(s.state));
  useEffect(() => {
    if (!isOfflineOnly()) return;
    const refresh = useStoreSchemaStore.getState().refresh;
    const id = setInterval(() => void refresh(), fast ? POLL_FAST_MS : POLL_MS);
    return () => {
      clearInterval(id);
    };
  }, [fast]);
  // Probe at once on mount only; a change of cadence must not fire an extra request.
  useEffect(() => {
    if (isOfflineOnly()) void useStoreSchemaStore.getState().refresh();
  }, []);
}
