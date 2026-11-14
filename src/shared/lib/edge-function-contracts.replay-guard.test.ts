/* eslint-disable import/order -- vi.mock factories must precede imports */
/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreModule from './license/store';
import type { LicenseEvaluation } from './license/types';

// Real contract in front of the real guard: only the network, the licence state and the token are faked.
vi.unmock('@shared/lib/supabase');
let evaluation: LicenseEvaluation = { state: 'active' };
vi.mock('./license/store', async importOriginal => ({
  ...(await importOriginal<typeof StoreModule>()),
  currentLicenseEvaluation: () => evaluation,
}));
vi.mock('@shared/lib/supabase', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedAccessToken: () => 'test-token',
}));

import { callProcessDirectSale } from './edge-function-contracts';

const request = {
  items: [
    {
      productId: '33333333-3333-4333-8333-333333333333',
      quantity: 1,
      unitPrice: 4.5,
      modifierIds: [],
      modifierPriceDelta: 0,
    },
  ],
  shiftId: '44444444-4444-4444-8444-444444444444',
  cajaSessionId: '55555555-5555-4555-8555-555555555555',
  idempotencyKey: 'direct_sale_1',
  method: 'cash' as const,
  amount: 4.5,
  tenderedAmount: 5,
  expectedTotal: 4.5,
};

const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })));

describe('callProcessDirectSale through the licence guard', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:56321');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('a restricted terminal refuses an ordinary sale', async () => {
    evaluation = { state: 'restricted', reason: 'lease_expired' };
    const result = await callProcessDirectSale(request);
    expect(result).toMatchObject({ ok: false, error: { code: 'LICENSE_RESTRICTED' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a restricted terminal sends the same sale as an offline replay', async () => {
    evaluation = { state: 'restricted', reason: 'lease_expired' };
    await callProcessDirectSale(request, { offlineReplay: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe('http://127.0.0.1:56321/functions/v1/process-direct-sale');
  });

  it('a hard locked terminal refuses even an offline replay', async () => {
    evaluation = { state: 'locked', reason: 'unlicensed' };
    const result = await callProcessDirectSale(request, { offlineReplay: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'LICENSE_LOCKED' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a mapped refusal keeps the edge code in details and changes nothing else', async () => {
    evaluation = { state: 'active' };
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'SHIFT_NOT_OPEN', message: 'Shift is not open or does not belong to this cashier' },
        }),
        { status: 409 }
      )
    );
    const result = await callProcessDirectSale(request);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'AUTH_FORBIDDEN',
        message: 'Shift is not open or does not belong to this cashier',
        details: 'SHIFT_NOT_OPEN: Shift is not open or does not belong to this cashier',
      },
    });
  });
});
