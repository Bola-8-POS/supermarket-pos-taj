// src/shared/lib/edge-function-contracts.runtime-url.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callProcessPayment } from './edge-function-contracts';
import type * as SupabaseModule from './supabase';

// Isolated like edge-function-contracts.license.test.ts: vi.mock hoists to the whole file.
vi.mock('./supabase', async importOriginal => {
  const actual = await importOriginal<typeof SupabaseModule>();
  return {
    ...actual,
    getCachedAccessToken: () => 'tok',
    getBackendUrl: () => 'https://storepc:47304',
    getBackendAnonKey: () => 'store-anon',
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a raw edge-function call uses the runtime backend, not the build-time one', () => {
  it('callProcessPayment posts to the runtime URL with the runtime anon key', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://build.example.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'build-anon');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));

    await callProcessPayment({
      tabId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      amount: 10,
      method: 'cash',
      idempotencyKey: 'payment_cash_abc',
      tenderedAmount: 20,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://storepc:47304/functions/v1/process-payment');
    expect((init as RequestInit).headers).toMatchObject({ apikey: 'store-anon' });
  });
});
