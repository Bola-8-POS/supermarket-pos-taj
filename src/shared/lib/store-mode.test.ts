import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getStoreCaSha256,
  getStoreConfigError,
  getStoreMode,
  INVENTORY_POLL_MS,
  inventoryPollIntervalMs,
  isOfflineOnly,
  resetStoreRuntimeConfigForTests,
  setStoreRuntimeConfig,
  storeConfigBlocksBackend,
} from './store-mode';

afterEach(() => {
  resetStoreRuntimeConfigForTests();
  vi.unstubAllEnvs();
});

describe('store mode', () => {
  it('is cloud when nothing says otherwise', () => {
    expect(getStoreMode()).toBe('cloud');
    expect(isOfflineOnly()).toBe(false);
    expect(inventoryPollIntervalMs()).toBe(false);
    expect(getStoreCaSha256()).toBe('');
    expect(getStoreConfigError()).toBe('');
  });

  it('follows the build-time VITE_STORE_MODE in a plain browser', () => {
    vi.stubEnv('VITE_STORE_MODE', 'offline-only');
    expect(getStoreMode()).toBe('offline-only');
    expect(inventoryPollIntervalMs()).toBe(INVENTORY_POLL_MS);
    vi.stubEnv('VITE_STORE_MODE', 'banana');
    expect(getStoreMode()).toBe('cloud');
  });

  it('prefers what the Rust side reported over the build-time value', () => {
    vi.stubEnv('VITE_STORE_MODE', 'offline-only');
    setStoreRuntimeConfig({ storeMode: 'cloud' });
    expect(getStoreMode()).toBe('cloud');
  });

  it('exposes the CA fingerprint and a refused-file code', () => {
    setStoreRuntimeConfig({ storeMode: 'offline-only', storeCaSha256: 'ab'.repeat(32) });
    expect(getStoreMode()).toBe('offline-only');
    expect(getStoreCaSha256()).toBe('ab'.repeat(32));
    setStoreRuntimeConfig({ storeMode: 'cloud', storeConfigError: 'STORE_URL_REJECTED' });
    expect(getStoreConfigError()).toBe('STORE_URL_REJECTED');
    expect(getStoreCaSha256()).toBe('');
  });

  it('treats anything but exactly offline-only as cloud', () => {
    for (const value of [undefined, '', 'Offline-Only', 'offline', 'hybrid']) {
      setStoreRuntimeConfig({ storeMode: value });
      expect(getStoreMode()).toBe('cloud');
    }
  });

  it('cloud till with no store.env and no VITE_STORE_MODE runs in cloud mode and is not blocked', () => {
    vi.stubEnv('VITE_STORE_MODE', '');
    // no Rust-side config at all (plain browser / no store.env)
    expect(getStoreMode()).toBe('cloud');
    expect(storeConfigBlocksBackend()).toBe(false);
    // Rust side ran, found no store.env: empty config
    setStoreRuntimeConfig({});
    expect(getStoreMode()).toBe('cloud');
    expect(storeConfigBlocksBackend()).toBe(false);
  });

  it('only a refused (malformed) store.env blocks the backend; untrusted owner/path is ignored', () => {
    for (const code of ['STORE_URL_REJECTED', 'STORE_KEY_MISSING', 'STORE_CA_MISSING', 'STORE_MODE_UNKNOWN', 'STORE_FILE_UNREADABLE']) {
      setStoreRuntimeConfig({ storeConfigError: code });
      expect(storeConfigBlocksBackend()).toBe(true);
    }
    for (const code of ['STORE_ENV_UNTRUSTED_OWNER', 'STORE_ENV_UNTRUSTED_PATH']) {
      setStoreRuntimeConfig({ storeConfigError: code });
      expect(storeConfigBlocksBackend()).toBe(false);
    }
  });
});
