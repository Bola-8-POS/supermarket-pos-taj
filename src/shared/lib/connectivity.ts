import { useEffect, useState } from 'react';
import { storeConfigBlocksBackend } from './store-mode';

const PROBE_TIMEOUT_MS = 4000;
const PROBE_INTERVAL_MS = 30_000;
// While unreachable, re-probe within seconds: one slow probe must not block every
// fail-fast write (checkout included) until the next 30s tick.
const UNREACHABLE_REPROBE_MS = 5_000;

type Verdict = 'unknown' | 'reachable' | 'unreachable';
let verdict: Verdict = 'unknown';
const listeners = new Set<() => void>();

function setVerdict(next: Verdict): void {
  if (next === verdict) return;
  verdict = next;
  listeners.forEach((l) => {
    l();
  });
}

let probeTarget: { url: string; anonKey: string } | null = null;

/**
 * Called by initSupabaseClient, so the probe follows a runtime-config backend
 * override (Tauri get_runtime_config) instead of the build-time VITE_ URL.
 */
export function setProbeTarget(url: string, anonKey: string): void {
  probeTarget = { url, anonKey };
}

/**
 * The backend the till is configured for, or null when none is set or a refused
 * store.env must not fall back to the cloud URL. A plain browser (dev server, e2e) that has not created the
 * client yet falls back to the build-time VITE_ pair, as probeReachability does.
 */
export function getProbeTarget(): { url: string; anonKey: string } | null {
  if (storeConfigBlocksBackend()) return null;
  if (probeTarget) return probeTarget;
  const url = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
  if (!url) return null;
  return { url, anonKey: (import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined) ?? '' };
}

/**
 * Returns true if the browser has a network connection AND the last
 * reachability probe (if any) reached the backend. A live network card with a
 * dead uplink reads as offline once the monitor has probed.
 * Safe to call outside of React (e.g. in Zustand actions).
 */
export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine && verdict !== 'unreachable';
}

/**
 * One-shot reachability probe against the Supabase gateway. Resolves `false` on
 * a transport failure or after PROBE_TIMEOUT_MS; never hangs.
 */
export async function probeReachability(): Promise<boolean> {
  const base = probeTarget?.url ?? (import.meta.env['VITE_SUPABASE_URL'] as string | undefined);
  const anonKey =
    probeTarget?.anonKey ?? (import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined) ?? '';
  if (!base) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  try {
    // GET only: licenseGuardedFetch rejects non-GET while the licence is locked.
    // /auth/v1/health is a tiny 200 — the /rest/v1/ root would download the whole
    // OpenAPI schema on every probe. Any HTTP status means the backend answered;
    // only a transport failure means unreachable.
    await fetch(`${base}/auth/v1/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { apikey: anonKey },
    });
    setVerdict('reachable');
    return true;
  } catch {
    setVerdict('unreachable');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Begins periodic probing; returns a stop function. Start once at app level. */
export function startConnectivityMonitor(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setVerdict('unreachable');
    } else {
      await probeReachability();
    }
    if (stopped) return;
    timer = setTimeout(
      () => void tick(),
      verdict === 'unreachable' ? UNREACHABLE_REPROBE_MS : PROBE_INTERVAL_MS
    );
  };
  void tick();
  const onOnline = (): void => void probeReachability();
  const onOffline = (): void => {
    setVerdict('unreachable');
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}

/**
 * Fix round 1 (re-review, N-I1): true when a replay failure means "this
 * request never reached the server" (or, for a locked terminal, was refused
 * before it tried) rather than a real server verdict — these must never
 * count toward `MAX_QUEUE_ATTEMPTS` or be dead-lettered, or a LAN-up/WAN-down
 * reconnect (or a locked terminal) burns all 5 attempts in ~30s of backoff
 * and silently loses a queued edit.
 *
 * `NETWORK_OFFLINE` is a mutation/query's own early-return when `isOnline()` is
 * false — never sent anywhere. Everything else here goes through
 * `supabase.rpc`, which is built on postgrest-js: a fetch-level failure (no
 * HTTP response at all) is caught internally and surfaced as `{ error: {
 * code: '', message: \`${err.name}: ${err.message}\` } }` — never a thrown
 * exception. A raw network failure's underlying error is always a `TypeError`
 * per the Fetch spec and an aborted/timed-out request is an `AbortError`;
 * neither maps to a SQLSTATE `parseSupabaseError` recognizes, so both land as
 * the generic `SUPABASE_ERROR` code and are caught by the message prefix.
 *
 * Licence refusals take the CODE branch. `licenseGuardedFetch` (supabase.ts)
 * rejects with a plain `Error` whose message carries `LICENSE_LOCKED:` or
 * `LICENSE_RESTRICTED:`; `parseSupabaseError` (via `licenseRefusal`,
 * result.ts) maps that to the typed `LICENSE_LOCKED`/`LICENSE_RESTRICTED`
 * AppErrorCode and strips the prefix from the message. The MESSAGE branch
 * only catches a refusal that still carries its raw prefix — one that never
 * went through `parseSupabaseError`. A restricted (lease/budget-expired)
 * store keeps its queue until it is relicensed.
 *
 * Schema refusals (`STORE_SCHEMA_MISMATCH`, store-schema/guard.ts) are held the same way: the
 * store is at a different schema level than this build, so a queued write or an offline-sale
 * replay waits for the gate to clear instead of being dead-lettered or sent to manager review.
 *
 * `SERVER_UNREACHABLE` is the typed form of an HTTP 502/503/504 from the gateway, produced by
 * `resilient-fetch.ts` (R3A b2); for an `open-tab` — a raw insert with no idempotency key — the
 * request may have committed, so a retry can leave one extra empty tab, which is accepted over
 * losing the held sale.
 */
export function isUnreachableFailure(code: string, message: string): boolean {
  if (
    code === 'NETWORK_OFFLINE' ||
    code === 'SERVER_UNREACHABLE' ||
    code === 'LICENSE_LOCKED' ||
    code === 'LICENSE_RESTRICTED' ||
    code === 'STORE_FROZEN' ||
    code === 'STORE_MOVED' ||
    code === 'STORE_SCHEMA_MISMATCH'
  ) {
    return true;
  }
  return (
    message.startsWith('TypeError:') ||
    message.startsWith('AbortError:') ||
    message.includes('LICENSE_LOCKED:') ||
    message.includes('LICENSE_RESTRICTED:') ||
    // A frozen or moved cloud store refuses the write; the work waits for the freeze to end or for the till to be paired.
    // Anchored (same pattern as storeSwitchRefusal in result.ts): an RPC- or postgrest-js-wrapped refusal counts, a code quoted mid-text does not.
    /^(?:Error: )?(?:[A-Z_]+_FAILED: )?(?:STORE_FROZEN|STORE_MOVED):/.test(message) ||
    message.includes('STORE_SCHEMA_MISMATCH:') ||
    // The session outlives a long outage (a failed refresh no longer signs the till out), so the
    // first replay after recovery can reach PostgREST with an expired access token before the
    // next auto-refresh tick. That is "not signed in yet", not a verdict on the action.
    message.startsWith('JWT expired')
  );
}

/**
 * Subscribes to every change isOnline() can make: probe verdict changes and the
 * window 'online'/'offline' events. Returns an unsubscribe function.
 */
export function subscribeConnectivity(listener: () => void): () => void {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  listeners.add(listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
    listeners.delete(listener);
  };
}

/**
 * Reactive hook that tracks isOnline(): re-renders on the window
 * 'online'/'offline' events and on every probe verdict change.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(isOnline);

  useEffect(() => {
    const update = () => {
      setOnline(isOnline());
    };
    const unsubscribe = subscribeConnectivity(update);
    update();
    return unsubscribe;
  }, []);

  return online;
}
