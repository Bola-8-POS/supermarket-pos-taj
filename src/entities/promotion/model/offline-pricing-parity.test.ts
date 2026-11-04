import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Promotion } from '@shared/lib/domain';
import { evaluateBestPromotion, round2, type PromotionPricingProduct } from './promotion-pricing';

// Characterization of the client pricing functions against process_direct_sale_atomic
// (supabase/migrations/20260927000002_role_permissions_server_checks.sql), the sole price
// authority. Offline sales are replayed through that RPC, which refuses a sale on any
// difference above 0.01, so every divergence pinned here is a refused offline sale.

const PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATEGORY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BASE_DAY_UTC = Date.UTC(2026, 8, 1); // Tuesday
const DAY_MS = 86_400_000;

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Parity promo',
    targets: [],
    kind: 'discount',
    discountType: 'percent',
    discountValue: 10,
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
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

function productAt(basePrice: number): PromotionPricingProduct {
  return { productId: PRODUCT_ID, categoryId: CATEGORY_ID, basePrice, weightGrams: undefined };
}

const idFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Postgres ROUND(numeric, 2) on an exact decimal given as integer thousandths: half away from zero. */
function sqlRoundOfThousandths(m: number): number {
  const cents = (m < 0 ? -1 : 1) * Math.floor((Math.abs(m) + 5) / 10);
  return cents / 100 + 0;
}

describe('offline pricing parity (client vs process_direct_sale_atomic)', () => {
  it('round2 matches SQL ROUND half-away-from-zero for money', () => {
    const thousandths = fc.oneof(
      fc.integer({ min: -5_000_000, max: 5_000_000 }),
      // exact half-cent values: 1.005, 2.675, 1.255, -1.005 ...
      fc.integer({ min: -500_000, max: 500_000 }).map(c => c * 10 + 5)
    );
    fc.assert(
      fc.property(thousandths, m => {
        expect(round2(m / 1000) + 0).toBe(sqlRoundOfThousandths(m));
      }),
      { numRuns: 2000, examples: [[1005], [2675], [1255], [-1005], [-2675], [-5], [5]] }
    );

    // the way production reaches a half cent: price * percent / 100
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100 }),
        (priceCents, pct) => {
          const sql = Math.floor((priceCents * pct + 50) / 100) / 100;
          expect(round2(((priceCents / 100) * pct) / 100)).toBe(sql);
        }
      ),
      { numRuns: 2000, examples: [[1005, 10]] }
    );
  });

  it('time-of-day boundary minute granularity (WR-03)', () => {
    const clock = (sec: number, short: boolean): string => {
      const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
      const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      return short && sec % 60 === 0 ? `${hh}:${mm}` : `${hh}:${mm}:${ss}`;
    };
    const window = fc.record({
      startSec: fc.integer({ min: 0, max: 86_398 }),
      len: fc.integer({ min: 1, max: 3600 }),
      edge: fc.constantFrom('start', 'end'),
      deltaMs: fc.constantFrom(-60_000, -1000, -1, 0, 1, 999, 1000, 30_000, 59_999, 60_000),
      shortStart: fc.boolean(),
      shortEnd: fc.boolean(),
      zone: fc.constantFrom(
        { tz: 'UTC', offsetMs: 0 },
        { tz: 'America/Mexico_City', offsetMs: 6 * 3_600_000 }
      ),
    });
    fc.assert(
      fc.property(window, w => {
        const endSec = Math.min(w.startSec + w.len, 86_399);
        const edgeMs = (w.edge === 'start' ? w.startSec : endSec) * 1000;
        const localMs = Math.min(Math.max(edgeMs + w.deltaMs, 0), DAY_MS - 1);
        const now = new Date(BASE_DAY_UTC + w.zone.offsetMs + localMs);
        const promo = makePromotion({
          startTime: clock(w.startSec, w.shortStart),
          endTime: clock(endSec, w.shortEnd),
        });
        // SQL: (now() AT TIME ZONE tz)::time BETWEEN start_time AND end_time
        const sqlApplies = localMs >= w.startSec * 1000 && localMs <= endSec * 1000;
        const match = evaluateBestPromotion(productAt(100), [promo], now, 0, null, 0, w.zone.tz);
        expect(match !== null).toBe(sqlApplies);
      }),
      {
        numRuns: 1500,
        examples: [
          // the review's case: window ends 18:00, 30 s later the server has stopped applying it
          [
            {
              startSec: 9 * 3600,
              len: 9 * 3600,
              edge: 'end',
              deltaMs: 30_000,
              shortStart: true,
              shortEnd: true,
              zone: { tz: 'UTC', offsetMs: 0 },
            },
          ],
        ],
      }
    );
  });

  it('empty daysOfWeek means no restriction in neither or both (WR-04)', () => {
    const SUNDAY_NOON_UTC = Date.UTC(2026, 8, 6, 12);
    const days = fc.oneof(
      fc.constant(null),
      fc.constant([] as number[]),
      fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 })
    );
    fc.assert(
      fc.property(days, fc.integer({ min: 0, max: 6 }), (daysOfWeek, dow) => {
        const now = new Date(SUNDAY_NOON_UTC + dow * DAY_MS);
        const promo = makePromotion({ daysOfWeek });
        // SQL: days_of_week IS NULL OR EXTRACT(DOW ...) = ANY(days_of_week); x = ANY('{}') is false
        const sqlApplies = daysOfWeek === null || daysOfWeek.includes(dow);
        const match = evaluateBestPromotion(productAt(100), [promo], now, 0, null, 0, 'UTC');
        expect(match !== null).toBe(sqlApplies);
      }),
      { numRuns: 500, examples: [[[], 2]] }
    );
  });

  it('fixed discount never exceeds the line price', () => {
    const NOW = new Date(BASE_DAY_UTC + 12 * 3_600_000);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 2_000_000 }),
        (priceCents, fixedCents) => {
          const price = priceCents / 100;
          const promo = makePromotion({ discountType: 'fixed', discountValue: fixedCents / 100 });
          const match = evaluateBestPromotion(productAt(price), [promo], NOW, 0, null, 0, 'UTC');
          // SQL: LEAST(p.discount_value, v_expected_price)
          const sqlAmount = Math.min(fixedCents, priceCents) / 100;
          expect(match?.discountAmount).toBe(sqlAmount);
          expect(match?.discountedUnitPrice).toBe(
            (priceCents - Math.min(fixedCents, priceCents)) / 100
          );
        }
      ),
      { numRuns: 1000 }
    );

    // the near-expiry percent is a bare settings value with no DB bound: still capped at the line price
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 101, max: 500 }),
        (priceCents, pct) => {
          const match = evaluateBestPromotion(
            productAt(priceCents / 100),
            [],
            NOW,
            pct,
            3,
            14,
            'UTC'
          );
          expect(match?.discountAmount).toBeLessThanOrEqual(priceCents / 100);
          expect(match?.discountedUnitPrice).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('best price wins ties by latest createdAt', () => {
    const NOW = new Date(BASE_DAY_UTC + 12 * 3_600_000);
    const tied = fc.record({
      priceCents: fc.integer({ min: 100, max: 100_000 }).map(c => c - (c % 100)),
      pct: fc.integer({ min: 1, max: 99 }),
      createdDays: fc.uniqueArray(fc.integer({ min: 0, max: 400 }), { minLength: 2, maxLength: 6 }),
      kinds: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
      seedOrder: fc.integer(),
    });
    fc.assert(
      fc.property(tied, t => {
        const price = t.priceCents / 100; // whole currency units: pct% of it is an exact cent amount
        const amount = round2((price * t.pct) / 100);
        const promos = t.createdDays.map((d, i) =>
          makePromotion({
            id: idFor(i + 1),
            // same amount either as percent or as a fixed value
            discountType: t.kinds[i] ? 'percent' : 'fixed',
            discountValue: t.kinds[i] ? t.pct : amount,
            createdAt: new Date(Date.UTC(2026, 0, 1) + d * DAY_MS),
          })
        );
        const latest = promos.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        const rotated = [
          ...promos.slice(t.seedOrder % promos.length),
          ...promos.slice(0, t.seedOrder % promos.length),
        ];
        const match = evaluateBestPromotion(productAt(price), rotated, NOW, t.pct, null, 14, 'UTC');
        expect(match?.promotionId).toBe(latest.id);

        // near-expiry candidate with the very same amount loses to the real promotion
        const withExpiry = evaluateBestPromotion(
          productAt(price),
          rotated,
          NOW,
          t.pct,
          1,
          14,
          'UTC'
        );
        expect(withExpiry?.promotionId).toBe(latest.id);
      }),
      { numRuns: 500 }
    );
  });
});
