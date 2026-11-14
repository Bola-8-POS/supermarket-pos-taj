import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('./supabase', () => ({
  supabase: {},
  getCachedAccessToken: () => 'test-access-token',
  getBackendUrl: () => 'http://localhost:54321',
  getBackendAnonKey: () => 'test-anon-key',
  licenseGuardedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { callProcessDirectSale, type ProcessDirectSaleRequest } from './edge-function-contracts';

function request(): ProcessDirectSaleRequest {
  return {
    items: [
      { productId: crypto.randomUUID(), quantity: 1, unitPrice: 10, modifierIds: [], modifierPriceDelta: 0 },
    ],
    shiftId: crypto.randomUUID(),
    cajaSessionId: crypto.randomUUID(),
    idempotencyKey: 'direct_sale_test_key_0001',
    method: 'cash',
    amount: 10,
    tenderedAmount: 10,
  };
}

// Gateway envelopes the store server answers with while its backend restarts (never a bare empty body).
function upstreamUnavailable(status: number): Response {
  return new Response(JSON.stringify({ code: 'UPSTREAM_UNAVAILABLE', message: 'Backend is starting.' }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
  });
}
function storeUpdating(): Response {
  return new Response(JSON.stringify({ code: 'STORE_UPDATING', message: 'Store is updating.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
  });
}

describe('callProcessDirectSale: outcome unknown (R3A b4)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it.each([502, 503, 504])('HTTP %i is PAYMENT_OUTCOME_UNKNOWN, not "payment could not be completed"', async status => {
    fetchMock.mockResolvedValue(upstreamUnavailable(status));
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('a 503 STORE_UPDATING envelope is also outcome unknown', async () => {
    fetchMock.mockResolvedValue(storeUpdating());
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
  });

  it('a connection that dies mid-request (fetch rejects with TypeError) is also outcome unknown', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
  });

  it('a 200 whose body cannot be read (connection dropped mid-body) is outcome unknown (final review 4)', async () => {
    const res = new Response('{}', { status: 200 });
    vi.spyOn(res, 'json').mockRejectedValue(new TypeError('terminated'));
    fetchMock.mockResolvedValue(res);
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
  });

  it('a licence refusal is still a licence error, not an outcome-unknown retry', async () => {
    fetchMock.mockRejectedValue(new Error('LICENSE_LOCKED: this terminal is not licensed'));
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('LICENSE_LOCKED');
  });

  it('returns_err_STORE_SCHEMA_MISMATCH', async () => {
    fetchMock.mockRejectedValue(new Error('STORE_SCHEMA_MISMATCH: server-outdated (server 1/1, till 2/2)'));
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STORE_SCHEMA_MISMATCH');
      expect(result.error.message).toBe('server-outdated (server 1/1, till 2/2)');
    }
  });

  it('a definite refusal (409 BELOW_COST_REQUIRES_OVERRIDE) is not outcome unknown', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: { code: 'BELOW_COST_REQUIRES_OVERRIDE', message: 'm' } }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BELOW_COST_REQUIRES_OVERRIDE');
  });

  it('a 500 RPC_ERROR is a definite server answer, not outcome unknown', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { code: 'RPC_ERROR', message: 'm' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe('PAYMENT_OUTCOME_UNKNOWN');
  });

  it('a 500 RECEIPT_FETCH (sale committed, receipt read failed) is outcome unknown', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { code: 'RECEIPT_FETCH' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const result = await callProcessDirectSale(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
  });

  it('a retry sends the identical idempotency key', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(upstreamUnavailable(503)));
    const req = request();
    await callProcessDirectSale(req);
    await callProcessDirectSale(req);
    const bodies = fetchMock.mock.calls.map(
      call => JSON.parse((call[1] as RequestInit).body as string) as { idempotencyKey: string }
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.idempotencyKey).toBe(bodies[1]?.idempotencyKey);
  });
});
