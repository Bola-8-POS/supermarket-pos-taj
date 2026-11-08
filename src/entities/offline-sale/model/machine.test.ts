import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OfflineSaleLastCodeSchema } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import {
  MAX_QUEUE_ATTEMPTS,
  UNREACHABLE_RETRY_MS,
  computeBackoffMs,
} from '@shared/lib/offline-retry';
import { applyOfflineSaleEvent, reduceOfflineSale, type OfflineSaleEvent } from './machine';
import { makeSale } from './offline-sale.fixtures';

const NOW = Date.parse('2026-10-09T10:05:00.000Z');
const TAB = '66666666-6666-4666-8666-666666666666';
const MANAGER = '77777777-7777-4777-8777-777777777777';
const RECEIPT = { receiptNumber: 'ABCDEF12', tabId: TAB } as unknown as ReceiptData;

describe('offline sale machine', () => {
  it('queued then replaying then confirmed', () => {
    const queued = makeSale();
    const replaying = reduceOfflineSale(queued, { type: 'replayStarted' }, NOW);
    expect(replaying.status).toBe('replaying');
    const done = reduceOfflineSale(
      replaying,
      { type: 'confirmed', tabId: TAB, receipt: RECEIPT },
      NOW
    );
    expect(done.status).toBe('confirmed');
    expect(done.tabId).toBe(TAB);
    expect(done.confirmedReceipt).toBe(RECEIPT);
    expect(done.confirmedAt).toBe(new Date(NOW).toISOString());
  });

  it('unreachable returns to queued without counting an attempt', () => {
    const replaying = makeSale({ status: 'replaying', attempts: 2 });
    const back = reduceOfflineSale(replaying, { type: 'unreachable' }, NOW);
    expect(back.status).toBe('queued');
    expect(back.attempts).toBe(2);
    expect(back.nextAttemptAt).toBe(new Date(NOW + UNREACHABLE_RETRY_MS).toISOString());
  });

  it('deterministic refusal goes to needs_review keeping the payload byte-identical', () => {
    const replaying = makeSale({ status: 'replaying' });
    const before = JSON.stringify(replaying.request);
    const review = reduceOfflineSale(
      replaying,
      { type: 'refused', code: 'PRICE_MISMATCH', message: 'price changed' },
      NOW
    );
    expect(review.status).toBe('needs_review');
    expect(review.lastCode).toBe('PRICE_MISMATCH');
    expect(review.lastMessage).toBe('price changed');
    expect(JSON.stringify(review.request)).toBe(before);
    expect(review.integrity).toBe(replaying.integrity);
  });

  it('a refusal that carries a server tab keeps it on the record', () => {
    const replaying = makeSale({ status: 'replaying' });
    const review = reduceOfflineSale(
      replaying,
      { type: 'refused', code: 'AMOUNT_MISMATCH', message: 'm', tabId: TAB },
      NOW
    );
    expect(review).toMatchObject({ status: 'needs_review', tabId: TAB });
    const plain = reduceOfflineSale(
      replaying,
      { type: 'refused', code: 'AMOUNT_MISMATCH', message: 'm' },
      NOW
    );
    expect(plain.tabId).toBeUndefined();
  });

  it('five unknown failures then needs_review UNKNOWN', () => {
    let sale = makeSale();
    for (let i = 1; i <= MAX_QUEUE_ATTEMPTS; i++) {
      sale = reduceOfflineSale(sale, { type: 'replayStarted' }, NOW);
      sale = reduceOfflineSale(sale, { type: 'failedUnknown', message: `boom ${String(i)}` }, NOW);
      expect(sale.attempts).toBe(i);
      if (i < MAX_QUEUE_ATTEMPTS) {
        expect(sale.status).toBe('queued');
        expect(sale.nextAttemptAt).toBe(new Date(NOW + computeBackoffMs(i)).toISOString());
      }
    }
    expect(sale.status).toBe('needs_review');
    expect(sale.lastCode).toBe('UNKNOWN');
    expect(sale.lastMessage).toBe('boom 5');
    expect(sale.nextAttemptAt).toBeUndefined();
  });

  it('confirmed and resolved are terminal', () => {
    const events: OfflineSaleEvent[] = [
      { type: 'enqueued' },
      { type: 'replayStarted' },
      { type: 'confirmed', tabId: TAB, receipt: RECEIPT },
      { type: 'unreachable' },
      { type: 'refused', code: 'CAJA_CLOSED', message: 'm' },
      { type: 'failedUnknown', message: 'm' },
      { type: 'retryRequested' },
      { type: 'resolved', resolution: 'written_off', by: MANAGER },
      { type: 'tampered' },
      { type: 'escalated' },
    ];
    for (const status of ['confirmed', 'resolved'] as const) {
      const sale = makeSale({ status });
      for (const event of events) {
        const result = applyOfflineSaleEvent(sale, event, NOW);
        expect(result.ignored).toBe(true);
        expect(result.record).toBe(sale);
      }
    }
  });

  it('retry from needs_review resets attempts', () => {
    const review = makeSale({
      status: 'needs_review',
      attempts: 5,
      lastCode: 'UNKNOWN',
      nextAttemptAt: new Date(NOW).toISOString(),
    });
    const back = reduceOfflineSale(review, { type: 'retryRequested' }, NOW);
    expect(back.status).toBe('queued');
    expect(back.attempts).toBe(0);
    expect(back.nextAttemptAt).toBeUndefined();
  });

  it('the machine ignores a retry request for a sale with re-ring attempt keys', () => {
    const review = makeSale({
      status: 'needs_review',
      attempts: 2,
      lastCode: 'AMOUNT_MISMATCH',
      reRingAttemptKeys: ['direct_sale_rr_1'],
    });
    expect(applyOfflineSaleEvent(review, { type: 'retryRequested' }, NOW)).toEqual({
      record: review,
      ignored: true,
    });
  });

  it('resolved records who, when and the optional re-ring link and overpayment', () => {
    const review = makeSale({ status: 'needs_review', lastCode: 'AMOUNT_MISMATCH' });
    const done = reduceOfflineSale(
      review,
      {
        type: 'resolved',
        resolution: 'rering',
        by: MANAGER,
        linkedTabId: TAB,
        customerOverpaid: 1.5,
      },
      NOW
    );
    expect(done).toMatchObject({
      status: 'resolved',
      resolution: 'rering',
      resolvedBy: MANAGER,
      linkedTabId: TAB,
      customerOverpaid: 1.5,
      resolvedAt: new Date(NOW).toISOString(),
    });
  });

  it('a queued sale can be moved to review', () => {
    const queued = makeSale({ attempts: 2, nextAttemptAt: new Date(NOW).toISOString() });
    const moved = reduceOfflineSale(queued, { type: 'escalated' }, NOW);
    expect(moved).toMatchObject({
      status: 'needs_review',
      lastCode: 'ESCALATED',
      attempts: 2,
    });
    expect(moved.nextAttemptAt).toBeUndefined();
    expect(moved.request).toBe(queued.request);
  });

  it('only a queued sale can be moved to review', () => {
    for (const status of ['replaying', 'needs_review', 'confirmed', 'resolved'] as const) {
      const sale = makeSale({ status });
      const r = applyOfflineSaleEvent(sale, { type: 'escalated' }, NOW);
      expect(r.ignored).toBe(true);
      expect(r.record).toBe(sale);
    }
  });

  it('a sale the server already holds can be resolved as already recorded', () => {
    const review = makeSale({ status: 'needs_review', lastCode: 'CAJA_CLOSED' });
    const done = reduceOfflineSale(
      review,
      { type: 'resolved', resolution: 'already_recorded', by: MANAGER, linkedTabId: TAB },
      NOW
    );
    expect(done).toMatchObject({ status: 'resolved', resolution: 'already_recorded', linkedTabId: TAB });
  });

  it('tampered moves a queued or replaying sale to needs_review TAMPERED', () => {
    for (const status of ['queued', 'replaying'] as const) {
      const r = reduceOfflineSale(makeSale({ status }), { type: 'tampered' }, NOW);
      expect(r.status).toBe('needs_review');
      expect(r.lastCode).toBe('TAMPERED');
    }
  });

  it('an event that does not apply is ignored and returns the same record', () => {
    const queued = makeSale();
    const r = applyOfflineSaleEvent(queued, { type: 'unreachable' }, NOW);
    expect(r.ignored).toBe(true);
    expect(r.record).toBe(queued);
    expect(applyOfflineSaleEvent(queued, { type: 'replayStarted' }, NOW).ignored).toBe(false);
  });

  it('a bare DIRECT_SALE_FAILED is not a refusal code, INVENTORY_NEGATIVE is', () => {
    expect(OfflineSaleLastCodeSchema.safeParse('DIRECT_SALE_FAILED').success).toBe(false);
    expect(OfflineSaleLastCodeSchema.safeParse('INVENTORY_NEGATIVE').success).toBe(true);
  });

  it('no event sequence removes a non-terminal record or lets a terminal one change status', () => {
    const eventArb: fc.Arbitrary<OfflineSaleEvent> = fc.constantFrom<OfflineSaleEvent>(
      { type: 'enqueued' },
      { type: 'replayStarted' },
      { type: 'confirmed', tabId: TAB, receipt: RECEIPT },
      { type: 'unreachable' },
      { type: 'refused', code: 'INVALID_ITEMS', message: 'm' },
      { type: 'failedUnknown', message: 'm' },
      { type: 'retryRequested' },
      { type: 'resolved', resolution: 'written_off', by: MANAGER },
      { type: 'tampered' },
      { type: 'escalated' }
    );
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), events => {
        let sale = makeSale();
        const request = JSON.stringify(sale.request);
        for (const event of events) {
          const next = reduceOfflineSale(sale, event, NOW);
          if (sale.status === 'confirmed' || sale.status === 'resolved') {
            expect(next.status).toBe(sale.status);
          }
          expect(next.id).toBe(sale.id);
          expect(JSON.stringify(next.request)).toBe(request);
          sale = next;
        }
      })
    );
  });
});
