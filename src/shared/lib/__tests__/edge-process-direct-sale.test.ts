/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
/**
 * Drives the real process-direct-sale handler with only its remote imports, the
 * Deno global and the RPC faked, to pin the coded 409 on RPC-raised business errors.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

let rpcError: { code: string; message: string } = { code: 'P0001', message: '' };

vi.mock('npm:@supabase/supabase-js@2.117.2', () => ({
  createClient: () => ({ rpc: () => Promise.resolve({ data: null, error: rpcError }) }),
}));
vi.mock('https://deno.land/x/zod@v3.23.8/mod.ts', async () => await import('zod'));
vi.mock('../../../../supabase/functions/_shared/caller.ts', () => ({
  verifyCaller: () => Promise.resolve({ ok: true, id: 'staff-1' }),
}));

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: () => 'x' },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  // Variable specifier: keeps Deno-only remote imports out of tsc's graph (src is not a Deno project).
  const entry = '../../../../supabase/functions/process-direct-sale/index.ts';
  await import(/* @vite-ignore */ entry);
});

const body = {
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
  idempotencyKey: 'k1',
  method: 'cash',
  amount: 4.5,
  tenderedAmount: 5,
  expectedTotal: 9,
};

describe('process-direct-sale RPC business errors', () => {
  it.each([
    ['AMOUNT_MISMATCH', 'AMOUNT_MISMATCH: Expected total does not match the derived sale total'],
    ['ZERO_TOTAL_SALE', 'ZERO_TOTAL_SALE: A sale that totals 0.00 cannot be paid'],
  ])('%s from the RPC is a coded 409, not a 500 RPC_ERROR', async (code, message) => {
    rpcError = { code: 'P0001', message };
    const res = await handler(
      new Request('http://x/functions/v1/process-direct-sale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe(code);
    expect(json.error.message).toBe(message);
  });
});
