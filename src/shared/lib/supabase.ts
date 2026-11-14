import { createClient } from '@supabase/supabase-js';
import { setProbeTarget } from './connectivity';
import i18n from './i18n';
import { currentLicenseEvaluation } from './license/store';
import { withResilientResponses } from './resilient-fetch';
import { storeConfigInvalidError, type AppError } from './result';
import { getStoreConfigError, isOfflineOnly, storeConfigBlocksBackend } from './store-mode';
import { guardWrite } from './store-schema/guard';
import { currentStoreSwitchState, readMovedFlag, useStoreSwitchStore } from './store-switch/store';
import type { Database } from './supabase.types';

/**
 * A restricted terminal is a licensed store that has been offline too long. It must be able to
 * sign in and close out its shift; it must not be able to start new business. Exact path
 * suffixes, so the default is refusal. Some entries are reads that PostgREST/edge functions
 * serve over POST (get_caja_report, get-server-time, the PIN checks).
 */
const RESTRICTED_ALLOWED = [
  '/functions/v1/staff-sign-in',
  '/functions/v1/change-own-pin', // forced PIN change is part of signing in
  '/functions/v1/get-server-time',
  '/rest/v1/rpc/verify_staff_pin',
  '/rest/v1/rpc/staff_pin_holder',
  '/rest/v1/rpc/get_caja_report',
  '/rest/v1/rpc/register_caja_entry',
  '/rest/v1/rpc/close_caja_session',
  '/rest/v1/rpc/record_audit',
  '/rest/v1/rpc/resolve_offline_sale', // a manager's offline-sale write-off or escalation keeps working (02c Ruling 19)
  '/rest/v1/rpc/report_till_sync', // a restricted till still tells the switch what is queued on it
  '/rest/v1/shifts', // clock in to sign in, clock out to close the shift
];

/** The one path a restricted terminal may call for a queued offline sale's replay (Ruling 15). */
const OFFLINE_REPLAY_PATH = '/functions/v1/process-direct-sale';

/**
 * Licensing lever for "block operations to the remote DB": while the terminal is locked
 * (unlicensed / invalid / suspended / demo) every non-read request except auth is refused
 * client-side; while restricted, only RESTRICTED_ALLOWED gets through. Reads still work so the
 * gate screen and login can render.
 *
 * `opts.offlineReplay` is how the offline-sale replayer widens `restricted` for ONE request: the
 * goods and money of a queued sale already changed hands, so blocking its replay would strand
 * them (Ruling 15, R24). It permits exactly `process-direct-sale` for that call and nothing else;
 * hard `locked` ignores it. supabase-js calls its fetch with two arguments, so only a direct
 * caller of this function can set it.
 */
export function licenseGuardedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { offlineReplay?: boolean }
): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (method === 'GET' || method === 'HEAD') return fetch(input, init);
  const path = new URL(url, location.href).pathname;
  if (path.includes('/auth/v1/')) return fetch(input, init);
  if (currentStoreSwitchState() === 'moved') {
    return Promise.reject(new Error(`STORE_MOVED: ${i18n.t('common:storeSwitch.moved.refused')}`));
  }
  const { state } = currentLicenseEvaluation();
  if (state === 'locked') {
    return Promise.reject(new Error('LICENSE_LOCKED: this terminal is not licensed — database writes are disabled'));
  }
  if (
    state === 'restricted' &&
    !RESTRICTED_ALLOWED.some(allowed => path.endsWith(allowed)) &&
    !(opts?.offlineReplay === true && path === OFFLINE_REPLAY_PATH)
  ) {
    return Promise.reject(new Error(`LICENSE_RESTRICTED: ${i18n.t('common:license.restricted.refused')}`));
  }
  // Offline-only: never write to a store at a different schema level (opts.offlineReplay is not consulted, D1).
  if (isOfflineOnly()) return guardWrite().then(() => fetch(input, init));
  return fetch(input, init);
}

type SupabaseClientType = ReturnType<typeof createClient<Database>>;

let _client: SupabaseClientType | null = null;
let _cachedAccessToken: string | null = null;
let _backend: { url: string; anonKey: string } | null = null;

// supabase-js restores a persisted session (localStorage -> internal state)
// asynchronously after createClient() returns — a query fired before that
// restore completes goes out with no auth header, hits RLS as anonymous, and
// (via TanStack Query's default staleTime) can cache an incorrect empty
// result for minutes even after the real session attaches. `onAuthStateChange`
// always fires an `INITIAL_SESSION` event once that restore attempt finishes
// (session present or not) — use it as the one authoritative "session
// resolution is done" signal.
let _sessionReady = false;
let _resolveSessionReady: (() => void) | null = null;
const _sessionReadyPromise = new Promise<void>(resolve => {
  _resolveSessionReady = resolve;
});

/** The PostgREST base URL as supabase-js normalised it; 'unknown' if no client can be built. The one source of backendKey(). */
export function restUrl(): string {
  try {
    // ponytail: `rest` is protected in the typings; read it loosely. getClient() lazily builds from VITE_ env like the Proxy does.
    const url = (getClient() as unknown as { rest?: { url?: unknown } }).rest?.url;
    return typeof url === 'string' || url instanceof URL ? String(url) : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function initSupabaseClient(url: string, anonKey: string): void {
  if (_client) return; // idempotent — only init once
  _backend = { url, anonKey };
  setProbeTarget(url, anonKey);
  _client = createClient<Database>(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
    global: { fetch: withResilientResponses(licenseGuardedFetch) },
  });
  // The persisted "store moved" flag must hold before anything renders or fetches (keyed by backendKey(), i.e. restUrl()).
  if (readMovedFlag(restUrl())) useStoreSwitchStore.getState().setState('moved');
  _client.auth.onAuthStateChange((_event, session) => {
    _cachedAccessToken = session?.access_token ?? null;
    if (!_sessionReady) {
      _sessionReady = true;
      _resolveSessionReady?.();
    }
  });
}

/**
 * The backend address and anon key in use: what the client was created with (the desktop app reads them at runtime
 * from the Rust side), else the build-time values (a plain browser). Every raw `fetch` to an edge function must use
 * these, never `import.meta.env.VITE_SUPABASE_URL` directly (a test enforces it).
 */
export function getBackendUrl(): string {
  if (!_backend) assertStoreConfigUsable();
  return _backend?.url ?? import.meta.env.VITE_SUPABASE_URL;
}

export function getBackendAnonKey(): string {
  if (!_backend) assertStoreConfigUsable();
  return _backend?.anonKey ?? import.meta.env.VITE_SUPABASE_ANON_KEY;
}

/** True once supabase-js has resolved its initial session restore attempt. */
export function isSupabaseSessionReady(): boolean {
  return _sessionReady;
}

/** Resolves once supabase-js's initial session restore attempt completes. */
export function waitForSupabaseSessionReady(): Promise<void> {
  return _sessionReadyPromise;
}

/** Thrown instead of falling back to the build-time cloud backend when this till's store.env was refused. */
export class StoreConfigInvalidError extends Error {
  readonly appError: AppError;
  constructor(code: string) {
    super(`STORE_CONFIG_INVALID: ${code}`);
    this.name = 'StoreConfigInvalidError';
    this.appError = storeConfigInvalidError(code);
  }
}

function assertStoreConfigUsable(): void {
  if (storeConfigBlocksBackend()) throw new StoreConfigInvalidError(getStoreConfigError());
}

function getClient(): SupabaseClientType {
  if (!_client) {
    assertStoreConfigUsable();
    // Dev fallback: use build-time VITE_ env vars
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (url && key) {
      initSupabaseClient(url, key);
    } else {
      throw new Error(
        'Supabase not initialized. Ensure AppConfigProvider ran before any DB access.'
      );
    }
  }
  // _client is guaranteed non-null here: either it was set before entry,
  // or initSupabaseClient just set it above (throws if url/key missing).
  const client = _client;
  if (!client) {
    throw new Error('Supabase client failed to initialize.');
  }
  return client;
}

// Backward-compatible proxy — all existing `supabase.from(...)` calls keep working
export const supabase = new Proxy({} as SupabaseClientType, {
  get(_t, prop) {
    return (getClient() as unknown as Record<string | symbol, unknown>)[prop as string];
  },
});

/** Returns the current user's JWT access token, or null if not authenticated. */
export function getCachedAccessToken(): string | null {
  return _cachedAccessToken;
}
