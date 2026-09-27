import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Promotion } from '@shared/lib/domain';
import {
  evaluateBestPromotion,
  getStoreLocalDowAndTime,
  type PromotionPricingProduct,
} from './promotion-pricing';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const TZ = 'America/Mexico_City';

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test promo',
    targets: [
      {
        id: 't1',
        promotionId: '11111111-1111-4111-8111-111111111111',
        productId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        categoryId: null,
      },
    ],
    kind: 'discount',
    discountType: 'percent',
    discountValue: 20,
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: new Date('2026-12-31T23:59:59.000Z'),
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    needsReview: false,
    active: true,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    createdBy: null,
    slots: [],
    ...overrides,
  };
}

const PRODUCT: PromotionPricingProduct = {
  productId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  categoryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  basePrice: 100,
};

describe('evaluateBestPromotion', () => {
  it('returns null when no candidate qualifies', () => {
    const result = evaluateBestPromotion(PRODUCT, [], NOW, 15, null, 14, TZ);
    expect(result).toBeNull();
  });

  it('one active product-targeted percent promotion — returns its discount', () => {
    const promo = makePromotion({ discountType: 'percent', discountValue: 20 });
    const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ);
    expect(result).toEqual({
      promotionId: promo.id,
      discountRate: 20,
      discountAmount: 20,
      discountedUnitPrice: 80,
    });
  });

  it('ignores combo-kind promotions', () => {
    const combo = makePromotion({ kind: 'combo', targets: [], discountValue: 999 });
    const result = evaluateBestPromotion(PRODUCT, [combo], NOW, 15, null, 14, TZ);
    expect(result).toBeNull();
  });

  it('store-wide promotion (zero targets, D-01) matches any product', () => {
    const promo = makePromotion({ targets: [], discountValue: 25 });
    const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ);
    expect(result?.promotionId).toBe(promo.id);
    expect(result?.discountAmount).toBe(25);
  });

  it('multi-target promotion (product array + category array) matches via either target', () => {
    const promo = makePromotion({
      targets: [
        {
          id: 't1',
          promotionId: '1',
          productId: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
          categoryId: null,
        },
        { id: 't2', promotionId: '1', productId: null, categoryId: PRODUCT.categoryId },
      ],
      discountValue: 30,
    });
    const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ);
    expect(result?.promotionId).toBe(promo.id);
  });

  it('a promotion with only unrelated targets does not match', () => {
    const promo = makePromotion({
      targets: [
        {
          id: 't1',
          promotionId: '1',
          productId: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
          categoryId: null,
        },
      ],
    });
    const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ);
    expect(result).toBeNull();
  });

  it('product-scoped vs category-scoped candidates — best price wins regardless of array order', () => {
    const smaller = makePromotion({
      id: '22222222-2222-4222-8222-222222222222',
      targets: [{ id: 't1', promotionId: '2', productId: PRODUCT.productId, categoryId: null }],
      discountType: 'percent',
      discountValue: 10, // $10 amount
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const bigger = makePromotion({
      id: '33333333-3333-4333-8333-333333333333',
      targets: [{ id: 't2', promotionId: '3', productId: null, categoryId: PRODUCT.categoryId }],
      discountType: 'fixed',
      discountValue: 25, // $25 amount
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    });

    const resultA = evaluateBestPromotion(PRODUCT, [smaller, bigger], NOW, 15, null, 14, TZ);
    const resultB = evaluateBestPromotion(PRODUCT, [bigger, smaller], NOW, 15, null, 14, TZ);
    expect(resultA?.promotionId).toBe(bigger.id);
    expect(resultA?.discountAmount).toBe(25);
    expect(resultB).toEqual(resultA);
  });

  it('exact tie — later createdAt wins (D-06)', () => {
    const earlier = makePromotion({
      id: '44444444-4444-4444-8444-444444444444',
      discountType: 'fixed',
      discountValue: 15,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const later = makePromotion({
      id: '55555555-5555-4555-8555-555555555555',
      discountType: 'fixed',
      discountValue: 15,
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    const result = evaluateBestPromotion(PRODUCT, [earlier, later], NOW, 15, null, 14, TZ);
    expect(result?.promotionId).toBe(later.id);
  });

  it('expiry trigger loses an exact tie against a real promotion (D-06)', () => {
    // expiryDiscountPercent=15 on basePrice=100 -> $15, matches the fixed promo's $15.
    const promo = makePromotion({ discountType: 'fixed', discountValue: 15 });
    const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, 10, 14, TZ);
    expect(result?.promotionId).toBe(promo.id);
  });

  it('daysUntilExpiry within threshold, no promotion beats it — returns expiry-trigger candidate', () => {
    const result = evaluateBestPromotion(PRODUCT, [], NOW, 15, 10, 14, TZ);
    expect(result).toEqual({
      promotionId: null,
      discountRate: 15,
      discountAmount: 15,
      discountedUnitPrice: 85,
    });
  });

  it('daysUntilExpiry exactly at threshold qualifies (inclusive)', () => {
    const result = evaluateBestPromotion(PRODUCT, [], NOW, 15, 14, 14, TZ);
    expect(result).not.toBeNull();
  });

  it('daysUntilExpiry beyond threshold does not qualify', () => {
    const result = evaluateBestPromotion(PRODUCT, [], NOW, 15, 15, 14, TZ);
    expect(result).toBeNull();
  });

  it('now exactly at startsAt qualifies (inclusive boundary)', () => {
    const promo = makePromotion({ startsAt: NOW, endsAt: new Date('2026-12-31T00:00:00.000Z') });
    const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ);
    expect(result?.promotionId).toBe(promo.id);
  });

  it('now exactly at endsAt qualifies (inclusive boundary)', () => {
    const promo = makePromotion({ startsAt: new Date('2026-08-01T00:00:00.000Z'), endsAt: NOW });
    const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ);
    expect(result?.promotionId).toBe(promo.id);
  });

  it('now before startsAt or after endsAt excludes the candidate', () => {
    const notYetStarted = makePromotion({
      startsAt: new Date('2026-09-02T00:00:00.000Z'),
      endsAt: new Date('2026-12-31T00:00:00.000Z'),
    });
    const alreadyEnded = makePromotion({
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(evaluateBestPromotion(PRODUCT, [notYetStarted], NOW, 15, null, 14, TZ)).toBeNull();
    expect(evaluateBestPromotion(PRODUCT, [alreadyEnded], NOW, 15, null, 14, TZ)).toBeNull();
  });

  describe('recurrence (D-03..D-06)', () => {
    // NOW = 2026-09-01T12:00:00.000Z is a Tuesday (dayOfWeek=2) in every
    // timezone this suite exercises; America/Mexico_City is UTC-6 (no DST
    // in 2026), so store-local wall time is 06:00.
    it('daysOfWeek exclusion — a day not in the array excludes the candidate', () => {
      const promo = makePromotion({ daysOfWeek: [0, 1] }); // Sun, Mon — not Tue
      expect(evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ)).toBeNull();
    });

    it('daysOfWeek inclusion — a day in the array qualifies', () => {
      const promo = makePromotion({ daysOfWeek: [2] }); // Tue
      const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ);
      expect(result?.promotionId).toBe(promo.id);
    });

    it('null/empty daysOfWeek means every day', () => {
      const nullDays = makePromotion({ daysOfWeek: null });
      const emptyDays = makePromotion({
        id: '66666666-6666-4666-8666-666666666666',
        daysOfWeek: [],
      });
      expect(evaluateBestPromotion(PRODUCT, [nullDays], NOW, 15, null, 14, TZ)?.promotionId).toBe(
        nullDays.id
      );
      expect(evaluateBestPromotion(PRODUCT, [emptyDays], NOW, 15, null, 14, TZ)?.promotionId).toBe(
        emptyDays.id
      );
    });

    it('startTime/endTime exclusion — outside the window excludes the candidate', () => {
      // Store-local wall time is 06:00 — window 16:00-18:00 excludes it.
      const promo = makePromotion({ startTime: '16:00', endTime: '18:00' });
      expect(evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ)).toBeNull();
    });

    it('startTime/endTime inclusion — inside the window qualifies', () => {
      const promo = makePromotion({ startTime: '05:00', endTime: '07:00' });
      const result = evaluateBestPromotion(PRODUCT, [promo], NOW, 15, null, 14, TZ);
      expect(result?.promotionId).toBe(promo.id);
    });

    it('startTime/endTime boundaries are inclusive', () => {
      const atStart = makePromotion({ startTime: '06:00', endTime: '07:00' });
      const atEnd = makePromotion({
        id: '77777777-7777-4777-8777-777777777777',
        startTime: '05:00',
        endTime: '06:00',
      });
      expect(evaluateBestPromotion(PRODUCT, [atStart], NOW, 15, null, 14, TZ)?.promotionId).toBe(
        atStart.id
      );
      expect(evaluateBestPromotion(PRODUCT, [atEnd], NOW, 15, null, 14, TZ)?.promotionId).toBe(
        atEnd.id
      );
    });

    it('cross-timezone: the same `now` resolves independently-correct dayOfWeek/hhmm per store timezone', () => {
      // 2026-09-01T12:00:00.000Z: America/Mexico_City (UTC-6) -> Tue 06:00;
      // Asia/Tokyo (UTC+9) -> Tue 21:00. A promotion whose window only fits
      // Tokyo's local time must NOT match when evaluated with Mexico City's
      // timezone, and vice versa — proving the function reads the passed
      // timezone argument, not a runtime-local fallback.
      const tokyoOnly = makePromotion({ startTime: '20:00', endTime: '22:00' });
      expect(evaluateBestPromotion(PRODUCT, [tokyoOnly], NOW, 15, null, 14, TZ)).toBeNull();
      expect(
        evaluateBestPromotion(PRODUCT, [tokyoOnly], NOW, 15, null, 14, 'Asia/Tokyo')?.promotionId
      ).toBe(tokyoOnly.id);
    });
  });

  describe('getStoreLocalDowAndTime', () => {
    it('computes Postgres EXTRACT(DOW)-convention day-of-week and HH:MM wall time', () => {
      const { dayOfWeek, hhmm } = getStoreLocalDowAndTime(NOW, TZ);
      expect(dayOfWeek).toBe(2); // Tuesday
      expect(hhmm).toBe('06:00');
    });

    it('never uses the runtime local zone — differs across two distinct timezones', () => {
      const mexico = getStoreLocalDowAndTime(NOW, 'America/Mexico_City');
      const tokyo = getStoreLocalDowAndTime(NOW, 'Asia/Tokyo');
      expect(mexico.hhmm).not.toBe(tokyo.hhmm);
    });
  });

  it('fast-check: discountAmount never exceeds basePrice, discountedUnitPrice never negative', () => {
    const promoArb = fc.record({
      id: fc.uuid(),
      name: fc.constant('Promo'),
      storeWide: fc.boolean(),
      discountType: fc.constantFrom<'percent' | 'fixed'>('percent', 'fixed'),
      discountValue: fc.float({ min: Math.fround(0.01), max: 100, noNaN: true }),
      daysOffsetStart: fc.integer({ min: -30, max: 0 }),
      daysOffsetEnd: fc.integer({ min: 0, max: 30 }),
      daysOffsetCreated: fc.integer({ min: -60, max: 0 }),
    });

    fc.assert(
      fc.property(
        fc.array(promoArb, { maxLength: 6 }),
        fc.float({ min: 1, max: 100_000, noNaN: true }).map(n => Math.round(n * 100) / 100),
        fc.option(fc.integer({ min: -5, max: 30 }), { nil: null }),
        fc.integer({ min: 0, max: 60 }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        (promoSpecs, basePrice, daysUntilExpiry, expiryThresholdDays, expiryDiscountPercent) => {
          const dayMs = 86_400_000;
          const promotions: Promotion[] = promoSpecs.map(spec => ({
            id: spec.id,
            name: spec.name,
            targets: spec.storeWide
              ? []
              : [
                  {
                    id: `t-${spec.id}`,
                    promotionId: spec.id,
                    productId: PRODUCT.productId,
                    categoryId: null,
                  },
                ],
            kind: 'discount',
            discountType: spec.discountType,
            discountValue: spec.discountValue,
            startsAt: new Date(NOW.getTime() + spec.daysOffsetStart * dayMs),
            endsAt: new Date(NOW.getTime() + spec.daysOffsetEnd * dayMs + dayMs),
            daysOfWeek: null,
            startTime: null,
            endTime: null,
            needsReview: false,
            active: true,
            createdAt: new Date(NOW.getTime() + spec.daysOffsetCreated * dayMs),
            createdBy: null,
            slots: [],
          }));
          const product: PromotionPricingProduct = {
            productId: PRODUCT.productId,
            categoryId: PRODUCT.categoryId,
            basePrice,
          };
          const result = evaluateBestPromotion(
            product,
            promotions,
            NOW,
            expiryDiscountPercent,
            daysUntilExpiry,
            expiryThresholdDays,
            TZ
          );
          if (result) {
            expect(result.discountAmount).toBeLessThanOrEqual(basePrice);
            expect(result.discountedUnitPrice).toBeGreaterThanOrEqual(0);
          }
        }
      )
    );
  });
});
