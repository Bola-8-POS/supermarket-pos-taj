// Plan 06 Task 13 (carry from Task 11): the runtime config must load before the first getClient(). A client created first
// would point at the build-time cloud URL and skip the STORE_CONFIG_INVALID refusal.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { invoke } from '@tauri-apps/api/core';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test-setup.ts mocks the client module globally; this file needs the real one, with only supabase-js counted.
vi.unmock('@shared/lib/supabase');
const createClient = vi.hoisted(() =>
  vi.fn(() => ({ auth: { onAuthStateChange: vi.fn() }, from: vi.fn() }))
);
vi.mock('@supabase/supabase-js', () => ({ createClient }));

// Fresh module graph per test: the client and the store config are module state.
const loadSupabase = () => import('@shared/lib/supabase');

describe('runtime config loads before the first getClient()', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    vi.resetModules();
    createClient.mockClear();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://build-time-cloud.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'build-time-anon');
  });
  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.unstubAllEnvs();
  });

  it('renders nothing that could touch the client until get_runtime_config answered, then uses the store address', async () => {
    let answer: (cfg: unknown) => void = () => undefined;
    vi.mocked(invoke).mockReturnValueOnce(new Promise(r => (answer = r)));
    const seen: string[] = [];
    function Probe() {
      void loadSupabase().then(m => seen.push(m.getBackendUrl()));
      return <p>child</p>;
    }
    const { AppConfigProvider } = await import('./AppConfigProvider');
    render(
      <AppConfigProvider>
        <Probe />
      </AppConfigProvider>
    );
    expect(screen.queryByText('child')).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    answer({ supabaseUrl: 'https://storepc:47304', supabaseAnonKey: 'store-anon', storeMode: 'offline-only' });
    await waitFor(() => {
      expect(seen).toEqual(['https://storepc:47304']);
    });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith('https://storepc:47304', 'store-anon', expect.anything());
  });

  it('a refused store.env makes the first client request throw instead of creating the build-time cloud client', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ supabaseUrl: '', supabaseAnonKey: '', storeConfigError: 'STORE_URL_REJECTED' });
    const { AppConfigProvider } = await import('./AppConfigProvider');
    render(
      <AppConfigProvider>
        <p>child</p>
      </AppConfigProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('child')).toBeTruthy();
    });
    const m = await loadSupabase();
    expect(() => m.supabase.from('products')).toThrow(/STORE_CONFIG_INVALID/);
    expect(() => m.getBackendUrl()).toThrow(/STORE_CONFIG_INVALID/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('both windows mount the whole app under AppConfigProvider, and main.tsx never imports the client itself', () => {
    for (const f of ['App.tsx', 'PeekApp.tsx']) {
      const src = readFileSync(resolve('src/app', f), 'utf8');
      const body = src.slice(src.indexOf('return ('));
      expect(body.indexOf('<AppConfigProvider>'), f).toBeGreaterThan(-1);
      for (const other of ['<Providers>', '<Router', '<LicenseGate', '<OfflineBanner']) {
        const at = body.indexOf(other);
        if (at !== -1) expect(at, `${f}: ${other} above AppConfigProvider`).toBeGreaterThan(body.indexOf('<AppConfigProvider>'));
      }
    }
    const main = readFileSync(resolve('src/main.tsx'), 'utf8');
    expect(main).not.toMatch(/shared\/lib\/supabase/);
  });
});
