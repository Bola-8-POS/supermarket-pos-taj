import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as contracts from './edge-function-contracts';
import {
  processCardPayment,
  processCashPayment,
  processPlatformPayment,
  processSplitPayment,
} from './payment-processor';
import { err, ok } from './result';

describe('payment-processor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const receipt = {
    receiptNumber: 'X',
    tabId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    customerName: 'C',
    cashierName: 'S',
    storeName: 'B',
    barAddress: '',
    items: [],
    subtotal: 10,
    total: 10,
    paymentMethod: 'cash' as const,
    processedAt: new Date(),
    squareReceiptUrl: null,
    tenderedAmount: 20,
    changeAmount: 9,
  };

  it('processCashPayment forwards idempotency and returns change', async () => {
    const spy = vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      ok({
        paymentId: 'pay-id',
        receiptData: receipt,
        idempotent: false,
      })
    );

    const r = await processCashPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10, 20);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.changeAmount).toBe(9);
      expect(r.data.paymentId).toBe('pay-id');
    }
    expect(spy).toHaveBeenCalledTimes(1);
    const tuple = spy.mock.calls[0];
    if (tuple === undefined) throw new Error('expected call');
    const arg = tuple[0];
    expect(arg.method).toBe('cash');
    expect(arg.tenderedAmount).toBe(20);
    expect(arg.idempotencyKey.startsWith('payment_cash_')).toBe(true);
  });

  it('processCardPayment omits empty reference', async () => {
    const spy = vi
      .spyOn(contracts, 'callProcessPayment')
      .mockResolvedValue(
        ok({
          paymentId: 'p2',
          receiptData: { ...receipt, paymentMethod: 'card' },
          idempotent: false,
        })
      );

    await processCardPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10, '   ');
    const cardTuple = spy.mock.calls[0];
    if (cardTuple === undefined) throw new Error('expected call');
    expect(cardTuple[0].referenceNumber).toBeUndefined();
  });

  it('processPlatformPayment sends trimmed reference number for rappi', async () => {
    const spy = vi
      .spyOn(contracts, 'callProcessPayment')
      .mockResolvedValue(
        ok({
          paymentId: 'p3',
          receiptData: { ...receipt, paymentMethod: 'rappi' },
          idempotent: false,
        })
      );

    await processPlatformPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10, 'rappi', '  R-1  ');
    const rappiTuple = spy.mock.calls[0];
    if (rappiTuple === undefined) throw new Error('expected call');
    expect(rappiTuple[0]).toMatchObject({
      method: 'rappi',
      referenceNumber: 'R-1',
    });
  });

  it('processPlatformPayment sends uber_eats method', async () => {
    const spy = vi
      .spyOn(contracts, 'callProcessPayment')
      .mockResolvedValue(
        ok({
          paymentId: 'p4',
          receiptData: { ...receipt, paymentMethod: 'uber_eats' },
          idempotent: false,
        })
      );

    await processPlatformPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10, 'uber_eats', 'U-1');
    const tuple = spy.mock.calls[0];
    if (tuple === undefined) throw new Error('expected call');
    expect(tuple[0]).toMatchObject({
      method: 'uber_eats',
      referenceNumber: 'U-1',
    });
    expect(tuple[0].idempotencyKey.startsWith('payment_uber_eats_')).toBe(true);
  });

  it('processPlatformPayment forwards managerOverride/managerPin (CR-02 regression, Phase 27 code review — a discounted platform payment used to drop these fields on the floor, bypassing manager-PIN authorization)', async () => {
    const spy = vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      ok({
        paymentId: 'p3',
        receiptData: { ...receipt, paymentMethod: 'rappi' },
        idempotent: false,
      })
    );

    await processPlatformPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 9, 'rappi', 'R-2', {
      scope: 'all',
      type: 'percent',
      value: 10,
      amount: 1,
      managerOverride: true,
      managerPin: '345678',
    });
    const rappiTuple = spy.mock.calls[0];
    if (rappiTuple === undefined) throw new Error('expected call');
    expect(rappiTuple[0]).toMatchObject({
      method: 'rappi',
      managerOverride: true,
      managerPin: '345678',
    });
  });

  it('processCashPayment forwards expectedVersion when supplied', async () => {
    const spy = vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      ok({
        paymentId: 'pay-id',
        receiptData: receipt,
        idempotent: false,
      })
    );

    await processCashPayment(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      10,
      20,
      undefined,
      5
    );
    const tuple = spy.mock.calls[0];
    if (tuple === undefined) throw new Error('expected call');
    expect(tuple[0].expectedVersion).toBe(5);
  });

  it('processCashPayment omits expectedVersion when not supplied', async () => {
    const spy = vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      ok({
        paymentId: 'pay-id',
        receiptData: receipt,
        idempotent: false,
      })
    );

    await processCashPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10, 20);
    const tuple = spy.mock.calls[0];
    if (tuple === undefined) throw new Error('expected call');
    expect(tuple[0].expectedVersion).toBeUndefined();
  });

  it('processCashPayment propagates callProcessPayment failure', async () => {
    vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      err({ code: 'VALIDATION_ERROR', message: 'Insufficient tender' })
    );

    const r = await processCashPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10, 50);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe('Insufficient tender');
    }
  });

  it('processCashPayment computes change from tendered when receipt changeAmount is null', async () => {
    vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      ok({
        paymentId: 'p1',
        receiptData: { ...receipt, changeAmount: null },
        idempotent: false,
      })
    );

    const r = await processCashPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10, 25.67);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.changeAmount).toBe(15.67);
    }
  });

  it('processCashPayment rounds fallback change to cents', async () => {
    vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      ok({
        paymentId: 'p1',
        receiptData: { ...receipt, changeAmount: undefined },
        idempotent: false,
      })
    );

    const r = await processCashPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 10.33, 20);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.changeAmount).toBe(9.67);
    }
  });

  it('processCardPayment passes trimmed referenceNumber', async () => {
    const spy = vi
      .spyOn(contracts, 'callProcessPayment')
      .mockResolvedValue(
        ok({
          paymentId: 'p2',
          receiptData: { ...receipt, paymentMethod: 'card' },
          idempotent: false,
        })
      );

    await processCardPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 5, '  AUTH123  ');
    const arg = spy.mock.calls[0]?.[0];
    expect(arg?.referenceNumber).toBe('AUTH123');
  });

  it('processCardPayment propagates failure', async () => {
    vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      err({ code: 'AUTH_FORBIDDEN', message: 'No' })
    );

    const r = await processCardPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('AUTH_FORBIDDEN');
    }
  });

  it('processPlatformPayment propagates failure', async () => {
    vi.spyOn(contracts, 'callProcessPayment').mockResolvedValue(
      err({ code: 'VALIDATION_ERROR', message: 'Rappi mismatch' })
    );

    const r = await processPlatformPayment(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      10,
      'rappi',
      'ORD'
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe('Rappi mismatch');
    }
  });

  describe('processSplitPayment', () => {
    const leg1 = { method: 'cash' as const, amount: 6, tenderedAmount: 10 };
    const leg2 = { method: 'card' as const, amount: 5 };

    it('returns ok with paymentGroupId + paymentIds + receipts for 2 legs summing to expectedTotal', async () => {
      const spy = vi.spyOn(contracts, 'callProcessSplitPayment').mockResolvedValue(
        ok({
          paymentGroupId: 'group-1',
          paymentIds: ['pay-1', 'pay-2'],
          receipts: [
            { ...receipt, paymentMethod: 'cash' },
            { ...receipt, paymentMethod: 'card' },
          ],
          idempotent: false,
        })
      );

      const r = await processSplitPayment(
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        [leg1, leg2],
        12.5
      );

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.paymentGroupId).toBe('group-1');
        expect(r.data.paymentIds).toHaveLength(2);
        expect(r.data.receipts).toHaveLength(2);
      }
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('passes a single idempotencyKey generated via generateIdempotencyKey(payment_split) to callProcessSplitPayment', async () => {
      const spy = vi.spyOn(contracts, 'callProcessSplitPayment').mockResolvedValue(
        ok({
          paymentGroupId: 'group-1',
          paymentIds: ['pay-1', 'pay-2'],
          receipts: [receipt, receipt],
          idempotent: false,
        })
      );

      await processSplitPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', [leg1, leg2], 12.5);

      const tuple = spy.mock.calls[0];
      if (tuple === undefined) throw new Error('expected call');
      expect(tuple[0].idempotencyKey.startsWith('payment_split_')).toBe(true);
    });

    it('forwards discountInfo (scope/type/value/amount) when provided', async () => {
      const spy = vi.spyOn(contracts, 'callProcessSplitPayment').mockResolvedValue(
        ok({
          paymentGroupId: 'group-1',
          paymentIds: ['pay-1', 'pay-2'],
          receipts: [receipt, receipt],
          idempotent: false,
        })
      );

      await processSplitPayment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', [leg1, leg2], 12.5, {
        scope: 'all',
        type: 'percent',
        value: 10,
        amount: 1.25,
        managerOverride: true,
        managerPin: '789012',
      });

      const tuple = spy.mock.calls[0];
      if (tuple === undefined) throw new Error('expected call');
      expect(tuple[0]).toMatchObject({
        discountScope: 'all',
        discountType: 'percent',
        discountValue: 10,
        discountAmount: 1.25,
        managerOverride: true,
        managerPin: '789012',
      });
    });

    it('returns the underlying error Result unchanged when callProcessSplitPayment returns err', async () => {
      vi.spyOn(contracts, 'callProcessSplitPayment').mockResolvedValue(
        err({ code: 'VALIDATION_ERROR', message: 'Sum of leg amounts must equal expectedTotal' })
      );

      const r = await processSplitPayment(
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        [leg1, leg2],
        12.5
      );

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('VALIDATION_ERROR');
        expect(r.error.message).toBe('Sum of leg amounts must equal expectedTotal');
      }
    });
  });
});
