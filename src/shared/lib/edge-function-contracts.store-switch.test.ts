import { afterEach, describe, expect, it, vi } from 'vitest';
import { callProcessPayment } from './edge-function-contracts';
import { useStoreSwitchStore } from './store-switch/store';
import type * as SupabaseModule from './supabase';

// Own file for the same reason as edge-function-contracts.license.test.ts: the real licenseGuardedFetch with a stubbed token.
vi.mock('./supabase', async importOriginal => {
  const actual = await importOriginal<typeof SupabaseModule>();
  return { ...actual, getCachedAccessToken: () => 'tok' };
});

describe('licenseGuardedFetch reaches STORE_MOVED at the raw-fetch call sites', () => {
  afterEach(() => {
    useStoreSwitchStore.setState({ state: 'active' });
    vi.restoreAllMocks();
  });

  it('never calls fetch and resolves STORE_MOVED for callProcessPayment', async () => {
    useStoreSwitchStore.setState({ state: 'moved' });
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
    if (!result.ok) expect(result.error.code).toBe('STORE_MOVED');
  });
});
