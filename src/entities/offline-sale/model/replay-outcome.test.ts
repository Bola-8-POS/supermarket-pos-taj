/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/lib/supabase', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedAccessToken: () => 'test-token',
}));

import {
  callProcessDirectSale,
  type ProcessDirectSaleSuccess,
  type ReceiptData,
} from '@shared/lib/edge-function-contracts';
import { err, ok, type Result } from '@shared/lib/result';
import type { AppError } from '@shared/lib/supabase-contracts';
import { makeSale } from './offline-sale.fixtures';
import { classifyReplayResult } from './replay-outcome';

const TAB = '66666666-6666-4666-8666-666666666666';
const receipt = (total: number) => ({ total, receiptNumber: 'ABCDEF12' }) as unknown as ReceiptData;
const success = (total: number, extra: Partial<ProcessDirectSaleSuccess> = {}) =>
  ok({ tabId: TAB, receiptData: receipt(total), ...extra } as ProcessDirectSaleSuccess);

const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:56321');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

/** The edge function's failure envelope, run through the real `callProcessDirectSale` and its mapper. */
async function edgeFailure(code: string, message: string): Promise<Result<ProcessDirectSaleSuccess, AppError>> {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ success: false, error: { code, message } }), { status: 409 })
  );
  return callProcessDirectSale(makeSale().request);
}

describe('classifyReplayResult', () => {
  it.each([
    ['AMOUNT_MISMATCH', 'Payment amount does not match the derived sale total', 'AMOUNT_MISMATCH'],
    ['AMOUNT_MISMATCH', 'Expected total does not match the derived sale total', 'AMOUNT_MISMATCH'],
    ['PRICE_MISMATCH', 'Price mismatch for item 1', 'PRICE_MISMATCH'],
    ['BELOW_COST_REQUIRES_OVERRIDE', 'Sale is below cost', 'BELOW_COST_REQUIRES_OVERRIDE'],
    ['DIRECT_SALE_FAILED', 'INVENTORY_NEGATIVE: Basmati rice 1kg', 'INVENTORY_NEGATIVE'],
    ['CAJA_CLOSED', 'Caja session is not open', 'CAJA_CLOSED'],
    ['SHIFT_NOT_OPEN', 'Shift is not open or does not belong to this cashier', 'SHIFT_NOT_OPEN'],
    ['FORBIDDEN', 'Staff member is not authorized to create a sale', 'FORBIDDEN'],
    ['IDEMPOTENCY_UNAUTHORIZED', 'Not authorized to replay this payment', 'IDEMPOTENCY_UNAUTHORIZED'],
    ['INVALID_ITEMS', 'At least one item is required', 'INVALID_ITEMS'],
    ['WEIGHT_OUT_OF_RANGE', 'Weight out of range', 'WEIGHT_OUT_OF_RANGE'],
    ['MODIFIER_MISMATCH', 'Modifier mismatch', 'MODIFIER_MISMATCH'],
    ['INVALID_METHOD', 'Provide one payment method or split legs', 'INVALID_METHOD'],
    ['ZERO_TOTAL_SALE', 'A sale that totals 0.00 cannot be paid', 'ZERO_TOTAL_SALE'],
    ['DIRECT_SALE_FAILED', 'ZERO_TOTAL_SALE: A sale that totals 0.00 cannot be paid', 'ZERO_TOTAL_SALE'],
  ])('classifies every Ruling 10 code: %s (%s) is refused as %s', async (code, message, expected) => {
    const { event, tabId } = classifyReplayResult(makeSale(), await edgeFailure(code, message));
    expect(event).toMatchObject({ type: 'refused', code: expected });
    expect(tabId).toBeUndefined();
  });

  it('a replay refused ZERO_TOTAL_SALE is classified refused and the record goes to review with that last code', async () => {
    const { event } = classifyReplayResult(makeSale(), await edgeFailure('ZERO_TOTAL_SALE', 'A sale that totals 0.00 cannot be paid'));
    expect(event).toEqual({ type: 'refused', code: 'ZERO_TOTAL_SALE', message: expect.any(String) });
  });

  it('classifies every Ruling 10 code: the code does not depend on the server wording', async () => {
    for (const [code, expected] of [
      ['AMOUNT_MISMATCH', 'AMOUNT_MISMATCH'],
      ['SHIFT_NOT_OPEN', 'SHIFT_NOT_OPEN'],
      ['FORBIDDEN', 'FORBIDDEN'],
      ['INVALID_METHOD', 'INVALID_METHOD'],
    ] as const) {
      const { event } = classifyReplayResult(makeSale(), await edgeFailure(code, 'any wording at all'));
      expect(event).toMatchObject({ type: 'refused', code: expected });
    }
  });

  it('classifies every Ruling 10 code: a refusal keeps the server text for the manager', async () => {
    const { event } = classifyReplayResult(makeSale(), await edgeFailure('PRICE_MISMATCH', 'Price mismatch for item 1'));
    expect(event).toMatchObject({ message: expect.stringContaining('Price mismatch for item 1') });
  });

  it.each([
    ['a bare DIRECT_SALE_FAILED', () => edgeFailure('DIRECT_SALE_FAILED', 'duplicate key value violates unique constraint')],
    ['an RPC_ERROR', () => edgeFailure('RPC_ERROR', 'Request failed')],
    ['an unmapped edge code', () => edgeFailure('SOMETHING_NEW', 'who knows')],
    ['an edge VALIDATION_ERROR that is neither amount nor method', () => edgeFailure('VALIDATION_ERROR', 'Invalid request')],
  ])('%s is counted as an unknown failure', async (_name, edge) => {
    expect(classifyReplayResult(makeSale(), await edge()).event).toMatchObject({ type: 'failedUnknown' });
  });

  it.each([
    // the checkout RPC wraps the guard's refusal in DIRECT_SALE_FAILED; errors.ts now lets the STORE_ prefix through
    ['DIRECT_SALE_FAILED', 'STORE_FROZEN: this store is being moved to its own server'],
    ['DIRECT_SALE_FAILED', 'STORE_MOVED: this store moved to its own server; pair this till with it'],
    // the raised (unwrapped) refusal, answered under its own code by failUnlessUpstream
    ['STORE_FROZEN', 'STORE_FROZEN: this store is being moved to its own server'],
    ['STORE_MOVED', 'STORE_MOVED: pair this till'],
  ])('a fence refusal (%s / "%s") is held: unreachable, never failedUnknown, never refused', async (code, message) => {
    const { event } = classifyReplayResult(makeSale(), await edgeFailure(code, message));
    expect(event).toEqual({ type: 'unreachable' });
  });

  it('a fence refusal that only survives in details is held too', () => {
    const result = err({ code: 'SUPABASE_ERROR', message: 'generic', details: 'DIRECT_SALE_FAILED: STORE_FROZEN: x' });
    expect(classifyReplayResult(makeSale(), result).event).toEqual({ type: 'unreachable' });
  });

  it.each([
    'PAYMENT_OUTCOME_UNKNOWN',
    'LICENSE_RESTRICTED',
    'LICENSE_LOCKED',
    'NETWORK_OFFLINE',
    'SERVER_UNREACHABLE',
    'AUTH_REQUIRED',
  ])('%s is held, not counted', code => {
    const { event } = classifyReplayResult(makeSale(), err({ code, message: 'x' }));
    expect(event).toEqual({ type: 'unreachable' });
  });

  it('schema_refusal_is_unreachable_not_failedUnknown', () => {
    const { event } = classifyReplayResult(makeSale(), err({ code: 'STORE_SCHEMA_MISMATCH', message: 'server-outdated' }));
    expect(event).toEqual({ type: 'unreachable' });
  });

  it('a success whose total equals the stored total is confirmed with the server receipt', () => {
    const { event, tabId } = classifyReplayResult(makeSale(), success(9));
    expect(event).toMatchObject({ type: 'confirmed', tabId: TAB });
    expect(tabId).toBe(TAB);
  });

  it('an idempotent success counts the same', () => {
    expect(classifyReplayResult(makeSale(), success(9, { idempotent: true })).event.type).toBe('confirmed');
  });

  it('totals are compared in whole cents', () => {
    const sale = makeSale();
    sale.request.expectedTotal = 0.1 + 0.2;
    expect(classifyReplayResult(sale, success(0.3)).event.type).toBe('confirmed');
  });

  it('a success with a different total is not confirmed', () => {
    const { event, tabId } = classifyReplayResult(makeSale(), success(9.5));
    expect(event).toMatchObject({ type: 'refused', code: 'AMOUNT_MISMATCH' });
    expect(tabId).toBe(TAB);
    const message = event.type === 'refused' ? event.message : '';
    expect(message).toContain(TAB);
    expect(message).toContain('9.50');
    expect(message).toContain('9.00');
    expect(event).toMatchObject({ tabId: TAB });
  });

  it('a split sale is compared against the sum of its legs when no expected total was stored', () => {
    const sale = makeSale();
    delete sale.request.expectedTotal;
    delete sale.request.method;
    delete sale.request.amount;
    delete sale.request.tenderedAmount;
    sale.request.legs = [
      { method: 'cash', amount: 5 },
      { method: 'card', amount: 4, referenceNumber: 'A1' },
    ];
    expect(classifyReplayResult(sale, success(9)).event.type).toBe('confirmed');
  });

  it('a success without a receipt cannot be confirmed and is counted', () => {
    const result = ok({ tabId: TAB } as ProcessDirectSaleSuccess);
    expect(classifyReplayResult(makeSale(), result).event).toMatchObject({ type: 'failedUnknown' });
  });
});
