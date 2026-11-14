import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromMock, rpcMock, invokeMock, chain } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  invokeMock: vi.fn(),
  chain: { select: vi.fn(), in: vi.fn(), limit: vi.fn() },
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: { from: fromMock, rpc: rpcMock, functions: { invoke: invokeMock } },
}));

import { findPaymentByIdempotencyKey } from './queries';

const K = 'direct_sale_1_abc';

function wire(limit: () => Promise<unknown>) {
  chain.select.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);
  chain.limit.mockImplementation(limit);
  fromMock.mockReturnValue(chain);
}

describe('findPaymentByIdempotencyKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns completed with the payment and tab ids, matching key and key-leg0', async () => {
    wire(() => Promise.resolve({ data: [{ id: 'pay-1', tab_id: 'tab-1' }], error: null }));
    const r = await findPaymentByIdempotencyKey(K);
    expect(r).toEqual({ ok: true, data: { status: 'completed', paymentId: 'pay-1', tabId: 'tab-1' } });
    expect(fromMock).toHaveBeenCalledWith('payments');
    expect(chain.in).toHaveBeenCalledWith('idempotency_key', [K, `${K}-leg0`]);
  });

  it('returns not_completed when no row exists', async () => {
    wire(() => Promise.resolve({ data: [], error: null }));
    expect(await findPaymentByIdempotencyKey(K)).toEqual({ ok: true, data: { status: 'not_completed' } });
  });

  it('maps a Supabase error to an error Result', async () => {
    wire(() => Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000', details: '', hint: '' } }));
    expect((await findPaymentByIdempotencyKey(K)).ok).toBe(false);
  });

  it('maps a thrown fetch to an error Result', async () => {
    wire(() => Promise.reject(new TypeError('fetch failed')));
    expect((await findPaymentByIdempotencyKey(K)).ok).toBe(false);
  });

  it('only reads: never calls rpc or the process-direct-sale function', async () => {
    wire(() => Promise.resolve({ data: [], error: null }));
    await findPaymentByIdempotencyKey(K);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
