// src/app/AppConfigProvider.test.tsx
import { invoke } from '@tauri-apps/api/core';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoreCaSha256,
  getStoreConfigError,
  getStoreMode,
  resetStoreRuntimeConfigForTests,
} from '@shared/lib/store-mode';
import { initSupabaseClient } from '@shared/lib/supabase';
import { AppConfigProvider } from './AppConfigProvider';

describe('AppConfigProvider and the store mode', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    resetStoreRuntimeConfigForTests();
    vi.mocked(initSupabaseClient).mockClear();
  });
  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    resetStoreRuntimeConfigForTests();
  });

  it('hands the Rust-side store mode and CA hash to the app and creates the client for the store address', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      supabaseUrl: 'https://storepc:47304',
      supabaseAnonKey: 'store-anon',
      storeMode: 'offline-only',
      storeCaSha256: 'ab'.repeat(32),
      storeConfigError: '',
      warnings: [],
    });
    render(
      <AppConfigProvider>
        <p>child</p>
      </AppConfigProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('child')).toBeTruthy();
    });
    expect(getStoreMode()).toBe('offline-only');
    expect(getStoreCaSha256()).toBe('ab'.repeat(32));
    expect(initSupabaseClient).toHaveBeenCalledWith('https://storepc:47304', 'store-anon');
  });

  it('mode_is_known_before_the_first_guarded_write: the mode is set before the client is created', async () => {
    let modeAtInit = '';
    vi.mocked(initSupabaseClient).mockImplementationOnce(() => {
      modeAtInit = getStoreMode();
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      supabaseUrl: 'https://storepc:47304',
      supabaseAnonKey: 'store-anon',
      storeMode: 'offline-only',
      storeCaSha256: '',
      storeConfigError: '',
      warnings: [],
    });
    render(
      <AppConfigProvider>
        <p>child</p>
      </AppConfigProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('child')).toBeTruthy();
    });
    expect(modeAtInit).toBe('offline-only');
  });

  it('a refused store.env is cloud mode with the reason exposed', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      supabaseUrl: '',
      supabaseAnonKey: '',
      storeMode: 'cloud',
      storeCaSha256: '',
      storeConfigError: 'STORE_URL_REJECTED',
      warnings: ['Ignored store.env'],
    });
    render(
      <AppConfigProvider>
        <p>child</p>
      </AppConfigProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('child')).toBeTruthy();
    });
    expect(getStoreMode()).toBe('cloud');
    expect(getStoreConfigError()).toBe('STORE_URL_REJECTED');
    expect(initSupabaseClient).not.toHaveBeenCalled();
  });

  it('an older Rust side with no store fields is cloud', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ supabaseUrl: '', supabaseAnonKey: '' });
    render(
      <AppConfigProvider>
        <p>child</p>
      </AppConfigProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('child')).toBeTruthy();
    });
    expect(getStoreMode()).toBe('cloud');
  });
});
