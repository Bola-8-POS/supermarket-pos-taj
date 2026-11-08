// src/shared/lib/backend-url.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test-setup.ts mocks the client module globally; this file tests the real one.
vi.unmock('@shared/lib/supabase');

describe('getBackendUrl / getBackendAnonKey', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://build.example.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'build-anon');
  });

  it('fall back to the build-time values before a client exists', async () => {
    const m = await import('./supabase');
    expect(m.getBackendUrl()).toBe('https://build.example.test');
    expect(m.getBackendAnonKey()).toBe('build-anon');
  });

  it('return what the client was created with once initSupabaseClient ran', async () => {
    const m = await import('./supabase');
    m.initSupabaseClient('https://storepc:47304', 'store-anon');
    expect(m.getBackendUrl()).toBe('https://storepc:47304');
    expect(m.getBackendAnonKey()).toBe('store-anon');
  });

  it('keep the first configuration: initSupabaseClient is idempotent', async () => {
    const m = await import('./supabase');
    m.initSupabaseClient('https://storepc:47304', 'store-anon');
    m.initSupabaseClient('https://other.example.test', 'other-anon');
    expect(m.getBackendUrl()).toBe('https://storepc:47304');
  });

  describe('a refused store.env (trusted file)', () => {
    for (const code of ['STORE_MODE_UNKNOWN', 'STORE_FILE_UNREADABLE', 'STORE_URL_REJECTED', 'SOMETHING_NEW']) {
      it(`${code}: no client and no URL from the build-time cloud project`, async () => {
        const m = await import('./supabase');
        const sm = await import('./store-mode');
        sm.setStoreRuntimeConfig({ storeMode: 'cloud', storeConfigError: code });
        expect(() => m.getBackendUrl()).toThrow(/STORE_CONFIG_INVALID/);
        expect(() => m.getBackendAnonKey()).toThrow(/STORE_CONFIG_INVALID/);
        expect(() => m.supabase.from('products')).toThrow(/STORE_CONFIG_INVALID/);
      });
    }

    it('the thrown error carries a typed AppError', async () => {
      const m = await import('./supabase');
      const sm = await import('./store-mode');
      sm.setStoreRuntimeConfig({ storeMode: 'cloud', storeConfigError: 'STORE_URL_REJECTED' });
      try {
        m.getBackendUrl();
        expect.unreachable();
      } catch (e) {
        expect((e as { appError?: { code: string } }).appError?.code).toBe('STORE_CONFIG_INVALID');
      }
    });

    it('STORE_ENV_UNTRUSTED_OWNER (a planted file) is ignored: the build-time cloud client keeps working', async () => {
      const m = await import('./supabase');
      const sm = await import('./store-mode');
      sm.setStoreRuntimeConfig({ storeMode: 'cloud', storeConfigError: 'STORE_ENV_UNTRUSTED_OWNER' });
      expect(m.getBackendUrl()).toBe('https://build.example.test');
      expect(() => m.supabase.from('products')).not.toThrow();
    });

    it('STORE_ENV_UNTRUSTED_PATH (redirected / non-local path) is ignored like a planted file', async () => {
      const m = await import('./supabase');
      const sm = await import('./store-mode');
      sm.setStoreRuntimeConfig({ storeMode: 'cloud', storeConfigError: 'STORE_ENV_UNTRUSTED_PATH' });
      expect(m.getBackendUrl()).toBe('https://build.example.test');
    });

    it('an initialised client is never revoked by a later error code', async () => {
      const m = await import('./supabase');
      const sm = await import('./store-mode');
      m.initSupabaseClient('https://storepc:47304', 'store-anon');
      sm.setStoreRuntimeConfig({ storeMode: 'offline-only', storeConfigError: 'STORE_URL_REJECTED' });
      expect(m.getBackendUrl()).toBe('https://storepc:47304');
    });
  });
});
