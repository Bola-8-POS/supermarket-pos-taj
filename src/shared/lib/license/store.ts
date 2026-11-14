import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isLicenseEnforced } from './config';
import {
  accrueRuntime,
  budgetConsumedFraction,
  OFFLINE_TICK_MS,
  offlineBudgetMs,
  REVALIDATE_AT_FRACTION,
  resetBudget,
  sanitizeBudget,
  type OfflineBudget,
} from './offline-budget';
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
   * winding the PC clock back cannot un-expire a lease. Freezing the clock is bounded
   * separately by `offlineBudget`, which keeps counting while the clock stands still.
   */
  maxSeenNow: number;
  /** Running time since the licence server was last reached; see offline-budget.ts. */
  offlineBudget: OfflineBudget;
  /** Latest server clock reading seen (signed token issued_at, or get-server-time). */
  lastTrustedServerTime: number | null;
  /** Advances maxSeenNow to a server clock reading; earlier readings are ignored. */
  noteTrustedServerTime: (epochMs: number) => void;
  setLicense: (token: string, payload: LicensePayload, licenseKey: string | null) => void;
  setLicenseKey: (key: string | null) => void;
  clearLicense: (reason: string | null) => void;
  /** Records a successful licence-server contact, which also clears the offline budget. */
  markHeartbeat: () => void;
  resetOfflineBudget: () => void;
  setLastError: (message: string | null) => void;
  touchClock: () => void;
  /** One tick of the offline runtime budget — call from the single ticker only. */
  accrueOfflineRuntime: () => void;
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
      offlineBudget: resetBudget(Date.now()),
      lastTrustedServerTime: null,
      noteTrustedServerTime: epochMs => {
        const last = get().lastTrustedServerTime;
        if (!Number.isFinite(epochMs) || (last !== null && epochMs <= last)) return;
        set({ lastTrustedServerTime: epochMs, maxSeenNow: Math.max(get().maxSeenNow, epochMs) });
      },
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
        get().resetOfflineBudget();
      },
      resetOfflineBudget: () => {
        set({ offlineBudget: resetBudget(getEffectiveNow()) });
      },
      setLastError: message => {
        set({ lastError: message });
      },
      touchClock: () => {
        const now = Date.now();
        if (now > get().maxSeenNow) set({ maxSeenNow: now });
      },
      accrueOfflineRuntime: () => {
        get().touchClock();
        set({
          offlineBudget: accrueRuntime(get().offlineBudget, getEffectiveNow(), 2 * OFFLINE_TICK_MS),
        });
      },
    }),
    {
      name: 'pos.license',
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<LicenseState>;
        return { ...current, ...p, offlineBudget: sanitizeBudget(p.offlineBudget, Date.now()) };
      },
    }
  )
);

/** Clock-rollback-resistant "now". */
export function getEffectiveNow(): number {
  return Math.max(Date.now(), useLicenseStore.getState().maxSeenNow);
}

/**
 * True when more than half the offline budget has been used since the licence server was last
 * reached (the budget resets on every successful contact). A reconnected terminal then completes
 * one heartbeat before it sells again; useLicenseHeartbeat retries it every tick until it does.
 */
export function requiresRevalidation(): boolean {
  if (!isLicenseEnforced()) return false;
  const state = useLicenseStore.getState();
  // An offline-token store can never heartbeat, so holding its sales would never clear.
  return state.licenseKey !== null && budgetFraction(state) > REVALIDATE_AT_FRACTION;
}

/** Offline budget consumed, against the budget that applies to this terminal (offlineBudgetMs). */
function budgetFraction(s: Pick<LicenseState, 'offlineBudget' | 'payload' | 'licenseKey'>): number {
  return budgetConsumedFraction(s.offlineBudget, offlineBudgetMs(s.payload, s.licenseKey));
}

/** Non-hook evaluation for module-level guards (supabase fetch wrapper, updater). */
export function currentLicenseEvaluation(): LicenseEvaluation {
  if (!isLicenseEnforced()) return { state: 'disabled' };
  const state = useLicenseStore.getState();
  return evaluateLicense(state.payload, getEffectiveNow(), budgetFraction(state), state.licenseKey !== null);
}

const TICK_MS = 60_000;

/** Reactive evaluation — re-computes on store changes and once a minute (day boundaries). */
export function useLicenseEvaluation(): LicenseEvaluation {
  const payload = useLicenseStore(s => s.payload);
  const offlineBudget = useLicenseStore(s => s.offlineBudget);
  const licenseKey = useLicenseStore(s => s.licenseKey);
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
  return evaluateLicense(
    payload,
    getEffectiveNow(),
    budgetFraction({ offlineBudget, payload, licenseKey }),
    licenseKey !== null
  );
}
