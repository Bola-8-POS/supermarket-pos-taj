import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callProcessPayment } from './edge-function-contracts';
import { useLicenseStore } from './license/store';
import type * as SupabaseModule from './supabase';

// Isolated in its own file because vi.mock hoists to the whole file — every
// other case in edge-function-contracts.test.ts needs the globally-mocked
// ./supabase from test-setup.ts, not this real, partial one.
// Keeps the real licenseGuardedFetch/initSupabaseClient/etc. and only swaps
// getCachedAccessToken so callProcessPayment gets past its own AUTH_REQUIRED
// guard and reaches the license gate instead.
vi.mock('./supabase', async importOriginal => {
  const actual = await importOriginal<typeof SupabaseModule>();
  return {
    ...actual,
    getCachedAccessToken: () => 'tok',
  };
});

describe('licenseGuardedFetch reaches LICENSE_LOCKED at the seven raw-fetch call sites', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_LICENSE_ENFORCE', 'true');
    // Leave payload null — evaluateLicense(null, now) is 'locked'.
    useLicenseStore.setState({ token: null, payload: null, lastError: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('never calls fetch and resolves LICENSE_LOCKED for callProcessPayment', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await callProcessPayment({
      tabId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      amount: 10,
      method: 'cash',
      idempotencyKey: 'payment_cash_abc',
      tenderedAmount: 20,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('LICENSE_LOCKED');
    }
  });
});
