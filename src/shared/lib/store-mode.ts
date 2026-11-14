/**
 * Which backend this terminal talks to. `cloud` (default) is hosted Supabase; `offline-only` is the store server on the
 * shop LAN. The desktop app learns it from the Rust side (`get_runtime_config`, read from `client\store.env`, written only
 * by posctl). A plain browser (dev server, Playwright) has no Rust side, so the build-time `VITE_STORE_MODE` answers.
 */

export type StoreMode = 'cloud' | 'offline-only';

export interface StoreRuntimeConfig {
  storeMode?: string | undefined;
  storeCaSha256?: string | undefined;
  storeConfigError?: string | undefined;
}

interface Resolved {
  mode: StoreMode;
  caSha256: string;
  configError: string;
}

let runtime: Resolved | null = null;

/** Called once by AppConfigProvider with what the Rust side returned. Anything but exactly `offline-only` is cloud. */
export function setStoreRuntimeConfig(cfg: StoreRuntimeConfig): void {
  runtime = {
    mode: cfg.storeMode === 'offline-only' ? 'offline-only' : 'cloud',
    caSha256: cfg.storeCaSha256 ?? '',
    configError: cfg.storeConfigError ?? '',
  };
}

export function getStoreMode(): StoreMode {
  if (runtime) return runtime.mode;
  return import.meta.env.VITE_STORE_MODE === 'offline-only' ? 'offline-only' : 'cloud';
}

export function isOfflineOnly(): boolean {
  return getStoreMode() === 'offline-only';
}

/** SHA-256 (64 hex) of the store root CA; empty outside Offline only. */
export function getStoreCaSha256(): string {
  return runtime?.caSha256 ?? '';
}

/** A stable code (`STORE_URL_REJECTED` ...) when a present store.env was refused; empty otherwise. */
export function getStoreConfigError(): string {
  return runtime?.configError ?? '';
}

/**
 * True when a present store.env was refused and the till must not fall back to the build-time cloud backend.
 * STORE_ENV_UNTRUSTED_OWNER / STORE_ENV_UNTRUSTED_PATH are the exceptions: a file planted by a non-admin (or reached
 * through a redirected / non-local path) is ignored, so it cannot brick a cloud till.
 */
export function storeConfigBlocksBackend(): boolean {
  const code = getStoreConfigError();
  return code !== '' && code !== 'STORE_ENV_UNTRUSTED_OWNER' && code !== 'STORE_ENV_UNTRUSTED_PATH';
}

/** Offline only has no Realtime: the inventory alerts poll instead. */
export const INVENTORY_POLL_MS = 30_000;

export function inventoryPollIntervalMs(): number | false {
  return isOfflineOnly() ? INVENTORY_POLL_MS : false;
}

export function resetStoreRuntimeConfigForTests(): void {
  runtime = null;
}
