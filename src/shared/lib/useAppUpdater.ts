/**
 * useAppUpdater hook
 *
 * Manages the full update lifecycle:
 * - Startup check (UPD-01)
 * - 4-hour periodic poll (UPD-02)
 * - Progress tracking during download (UPD-08)
 * - Silent failure on network error or no update (UPD-07)
 * - Dismiss / remind-later (UPD-05)
 * - Manual "Check for updates" from Settings → License (`checkForUpdates`)
 *
 * State lives in a zustand store so the global dialog (app/providers) and the
 * Settings button share one state machine — a manual check that finds an
 * update opens the same install dialog as the background poll.
 */

import { relaunch as tauriRelaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { useEffect } from 'react';
import { create } from 'zustand';
import { isLicenseEnforced } from '@shared/lib/license/config';
import { getEffectiveNow, useLicenseStore } from '@shared/lib/license/store';
import { updatesExpired } from '@shared/lib/license/token';
import { logger } from '@shared/lib/logger-instance';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000; // 14_400_000 ms

export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string; changelog: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'restart-ready'; version: string }
  | { phase: 'error' };

/** Outcome of a single check — `skipped` = lifetime-license update window has ended. */
export type UpdateCheckOutcome = 'available' | 'none' | 'error' | 'skipped';

export interface UseAppUpdaterReturn {
  state: UpdaterState;
  startInstall: () => Promise<void>;
  dismissUpdate: () => void;
  relaunch: () => Promise<void>;
}

type UpdateHandle = NonNullable<Awaited<ReturnType<typeof check>>>;

interface UpdaterStore {
  state: UpdaterState;
  update: UpdateHandle | null;
  checkForUpdates: () => Promise<UpdateCheckOutcome>;
  startInstall: () => Promise<void>;
  dismissUpdate: () => void;
}

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
  state: { phase: 'idle' },
  update: null,

  checkForUpdates: async () => {
    // Lifetime licenses include 4 years of regular updates — after updates_until the
    // installed version keeps working but no longer polls for new releases.
    if (isLicenseEnforced() && updatesExpired(useLicenseStore.getState().payload, getEffectiveNow())) {
      logger.info('updater.skipped_updates_expired');
      return 'skipped';
    }
    try {
      const update = await check();
      if (!update) return 'none'; // null = no update available = silent (UPD-07)
      set({
        update,
        state: { phase: 'available', version: update.version, changelog: update.body ?? '' },
      });
      return 'available';
    } catch (err) {
      logger.warn('updater.check_failed', { err });
      return 'error'; // UPD-07: background callers stay silent — no UI change
    }
  },

  startInstall: async () => {
    const { state, update } = get();
    if (state.phase !== 'available' || !update) return;
    const { version } = state;

    let downloaded = 0;
    let contentLength = 0;
    set({ state: { phase: 'downloading', version, percent: 0 } });

    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              set({
                state: {
                  phase: 'downloading',
                  version,
                  percent: Math.min(100, Math.round((downloaded / contentLength) * 100)),
                },
              });
            }
            break;
          case 'Finished':
            set({ state: { phase: 'restart-ready', version } });
            break;
        }
      });
      // downloadAndInstall resolves after Finished — ensure restart-ready state
      set({ state: { phase: 'restart-ready', version } });
    } catch (err) {
      logger.error('updater.install_failed', { err });
      set({ state: { phase: 'error' } });
    }
  },

  dismissUpdate: () => {
    set({ state: { phase: 'idle' } });
  },
}));

export function useAppUpdater(): UseAppUpdaterReturn {
  const state = useUpdaterStore((s) => s.state);
  const startInstall = useUpdaterStore((s) => s.startInstall);
  const dismissUpdate = useUpdaterStore((s) => s.dismissUpdate);

  useEffect(() => {
    const { checkForUpdates } = useUpdaterStore.getState();
    void checkForUpdates();
    const interval = setInterval(() => {
      void checkForUpdates();
    }, FOUR_HOURS_MS);
    return () => {
      clearInterval(interval);
    };
  }, []);

  const relaunch = async (): Promise<void> => {
    await tauriRelaunch();
  };

  return { state, startInstall, dismissUpdate, relaunch };
}
