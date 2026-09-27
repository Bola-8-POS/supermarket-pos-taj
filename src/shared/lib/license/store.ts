import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isLicenseEnforced } from './config';
import { evaluateLicense } from './token';
import type { LicenseEvaluation, LicensePayload } from './types';

interface LicenseState {
  /** Signed token as received from the server / pasted offline. */
  token: string | null;
  /** Verified payload of `token` (verification happens before setLicense is called). */
  payload: LicensePayload | null;
  /** License key typed at activation — needed for heartbeats. */
  licenseKey: string | null;
  lastHeartbeatAt: string | null;
  /** Last server rejection / verification failure, surfaced on the gate screen. */
  lastError: string | null;
  /**
   * Highest wall-clock time ever observed. Evaluation uses max(now, maxSeenNow) so
   * winding the PC clock back cannot un-expire a lease. ponytail: deterrent only —
   * a store that never reconnects can still freeze time; acceptable at this scale.
   */
  maxSeenNow: number;
  setLicense: (token: string, payload: LicensePayload, licenseKey: string | null) => void;
  setLicenseKey: (key: string | null) => void;
  clearLicense: (reason: string | null) => void;
  markHeartbeat: () => void;
  setLastError: (message: string | null) => void;
  touchClock: () => void;
}

/**
 * Lives in shared/lib (like lock-state-store) so shared/lib/supabase.ts's fetch guard and
 * shared/ui banners can read it without inverting the FSD import direction.
 */
export const useLicenseStore = create<LicenseState>()(
  persist(
    (set, get) => ({
      token: null,
      payload: null,
      licenseKey: null,
      lastHeartbeatAt: null,
      lastError: null,
      maxSeenNow: 0,
      setLicense: (token, payload, licenseKey) => {
        set({ token, payload, licenseKey: licenseKey ?? get().licenseKey, lastError: null });
      },
      setLicenseKey: key => {
        set({ licenseKey: key });
      },
      clearLicense: reason => {
        set({ token: null, payload: null, lastError: reason });
      },
      markHeartbeat: () => {
        set({ lastHeartbeatAt: new Date().toISOString() });
      },
      setLastError: message => {
        set({ lastError: message });
      },
      touchClock: () => {
        const now = Date.now();
        if (now > get().maxSeenNow) set({ maxSeenNow: now });
      },
    }),
    { name: 'pos.license' }
  )
);

/** Clock-rollback-resistant "now". */
export function getEffectiveNow(): number {
  return Math.max(Date.now(), useLicenseStore.getState().maxSeenNow);
}

/** Non-hook evaluation for module-level guards (supabase fetch wrapper, updater). */
export function currentLicenseEvaluation(): LicenseEvaluation {
  if (!isLicenseEnforced()) return { state: 'disabled' };
  return evaluateLicense(useLicenseStore.getState().payload, getEffectiveNow());
}

const TICK_MS = 60_000;

/** Reactive evaluation — re-computes on store changes and once a minute (day boundaries). */
export function useLicenseEvaluation(): LicenseEvaluation {
  const payload = useLicenseStore(s => s.payload);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      useLicenseStore.getState().touchClock();
      setTick(t => t + 1);
    }, TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  void tick;
  if (!isLicenseEnforced()) return { state: 'disabled' };
  return evaluateLicense(payload, getEffectiveNow());
}
