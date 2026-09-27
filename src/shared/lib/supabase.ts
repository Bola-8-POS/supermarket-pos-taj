import { createClient } from '@supabase/supabase-js';
import { currentLicenseEvaluation } from './license/store';
import type { Database } from './supabase.types';

/**
 * Licensing lever for "block operations to the remote DB": while the terminal is locked
 * (unlicensed / expired / suspended) every non-read request except auth is refused
 * client-side. Reads still work so the gate screen and login can render.
 */
export function licenseGuardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (method !== 'GET' && method !== 'HEAD' && !url.includes('/auth/v1/') && currentLicenseEvaluation().state === 'locked') {
    return Promise.reject(new Error('LICENSE_LOCKED: this terminal is not licensed — database writes are disabled'));
  }
  return fetch(input, init);
}

type SupabaseClientType = ReturnType<typeof createClient<Database>>;

let _client: SupabaseClientType | null = null;
let _cachedAccessToken: string | null = null;

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

export function initSupabaseClient(url: string, anonKey: string): void {
  if (_client) return; // idempotent — only init once
  _client = createClient<Database>(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
    global: { fetch: licenseGuardedFetch },
  });
  _client.auth.onAuthStateChange((_event, session) => {
    _cachedAccessToken = session?.access_token ?? null;
    if (!_sessionReady) {
      _sessionReady = true;
      _resolveSessionReady?.();
    }
  });
}

/** True once supabase-js has resolved its initial session restore attempt. */
export function isSupabaseSessionReady(): boolean {
  return _sessionReady;
}

/** Resolves once supabase-js's initial session restore attempt completes. */
export function waitForSupabaseSessionReady(): Promise<void> {
  return _sessionReadyPromise;
}

function getClient(): SupabaseClientType {
  if (!_client) {
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
