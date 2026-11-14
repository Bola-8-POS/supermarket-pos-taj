/**
 * resolveProductPromotion vs process_direct_sale_atomic, for the two inputs the checkout screen
 * used to price differently from the server (two-mode Plan 02b, Task 2b). Real pricing code, no
 * mocks. SQL = supabase/migrations/20260927000002_role_permissions_server_checks.sql.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Promotion } from '@shared/lib/domain';
import { resolveProductPromotion } from './resolve-product-promotion';

const settings = {
  nearExpiry: { discountPercent: 15, thresholdDays: 14 },
  general: { timezone: 'America/Mexico_City' },
};

function promo(over: Partial<Promotion>): Promotion {
  return {
    id: 'promo-1',
    name: 'p',
    targets: [],
    kind: 'discount',
    discountType: 'fixed',
    discountValue: 1,
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: new Date('2027-01-01T00:00:00Z'),
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    needsReview: false,
    active: true,
    createdAt: new Date('2026-02-01T00:00:00Z'),
    createdBy: null,
    slots: [],
    ...over,
  };
}

const NOW = new Date('2026-10-09T18:00:00Z');
const kg = { id: 'prod-kg', categoryId: 'cat-1', basePrice: 12.35 };

describe('loose-weight line: the discount is taken on the line price (SQL :214-215, :231-235)', () => {
  it('a fixed discount on a weighed line is per kg (Ruling 11)', () => {
    // line = ROUND(12.35 * 375 / 1000, 2) = 4.63; fixed 2.00 per kg x 0.375 kg = 0.75 off -> 3.88
    const match = resolveProductPromotion(
      kg,
      [promo({ discountType: 'fixed', discountValue: 2 })],
      settings,
      undefined,
      NOW,
      375
    );
    expect(match).toMatchObject({ discountAmount: 0.75, discountedUnitPrice: 3.88 });
  });

  it('a percent discount is rounded on the line', () => {
    // 33% of 4.63 = 1.5279 -> 1.53 -> 3.10
    const match = resolveProductPromotion(
      kg,
      [promo({ discountType: 'percent', discountValue: 33 })],
      settings,
      undefined,
      NOW,
      375
    );
    expect(match).toMatchObject({ discountAmount: 1.53, discountedUnitPrice: 3.1 });
  });

  it('a fixed discount never exceeds the line price (SQL LEAST(value, line))', () => {
    // 100 g = 1.24 (1.235 rounds away from zero); fixed 20 per kg = 2.00 is capped at the line
    const match = resolveProductPromotion(
      kg,
      [promo({ discountType: 'fixed', discountValue: 20 })],
      settings,
      undefined,
      NOW,
      100
    );
    expect(match).toMatchObject({ discountAmount: 1.24, discountedUnitPrice: 0 });
  });

  it('without a weight the price is the unit price, as before', () => {
    const match = resolveProductPromotion(
      kg,
      [promo({ discountType: 'fixed', discountValue: 2 })],
      settings,
      undefined,
      NOW
    );
    expect(match).toMatchObject({ discountAmount: 2, discountedUnitPrice: 10.35 });
  });

  it('matches an integer-cent model of the SQL for generated lines', () => {
    const halfUp = (num: number, den: number): number => Math.floor((2 * num + den) / (2 * den));
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20_000 }), // price per kg, cents
        fc.integer({ min: 1, max: 50_000 }), // grams
        fc.constantFrom('percent' as const, 'fixed' as const),
        fc.integer({ min: 1, max: 10_000 }), // percent in basis points / fixed in cents
        (priceCents, grams, type, valueRaw) => {
          const lineCents = halfUp(priceCents * grams, 1000);
          const value = type === 'percent' ? Math.min(valueRaw, 10_000) / 100 : valueRaw / 100;
          const discountCents =
            type === 'percent'
              ? halfUp(lineCents * Math.round(value * 100), 10_000)
              : Math.min(halfUp(Math.round(value * 100) * grams, 1000), lineCents);
          const match = resolveProductPromotion(
            { id: 'p', categoryId: 'c', basePrice: priceCents / 100 },
            [promo({ discountType: type, discountValue: value })],
            settings,
            undefined,
            NOW,
            grams
          );
          expect(match).not.toBeNull();
          expect(Math.round(match!.discountedUnitPrice * 100)).toBe(lineCents - discountCents);
        }
      )
    );
  });
});

describe('near-expiry tier: the day count comes from the expiry DATE at pricing time (SQL :256)', () => {
  // SQL: v_expiry_date <= CURRENT_DATE + threshold, CURRENT_DATE = the database session date (UTC)
  const unit = { id: 'prod-e', categoryId: 'cat-1', basePrice: 100 };
  const dated = (expiryDate: string) => [{ productId: 'prod-e', expiryDate }];

  it('applies the tier on the threshold day itself', () => {
    // 2026-10-09 + 14 = 2026-10-23
    const match = resolveProductPromotion(unit, [], settings, dated('2026-10-23'), NOW);
    expect(match).toMatchObject({ promotionId: null, discountAmount: 15, discountedUnitPrice: 85 });
  });

  it('does not apply the tier the day after the threshold day', () => {
    expect(resolveProductPromotion(unit, [], settings, dated('2026-10-24'), NOW)).toBeNull();
  });

  it('counts the same date later: a list fetched a week ago prices the product inside the tier today', () => {
    // fetched on 2026-10-02 the product (2026-10-23) was 21 days out, outside the tier; today it is 14
    const fetchedWeekAgo = dated('2026-10-23');
    expect(resolveProductPromotion(unit, [], settings, fetchedWeekAgo, new Date('2026-10-02T12:00:00Z'))).toBeNull();
    expect(resolveProductPromotion(unit, [], settings, fetchedWeekAgo, NOW)).toMatchObject({ discountAmount: 15 });
  });

  it('counts days against the store-local date, not the database (UTC) date', () => {
    // 2026-10-10T03:00Z is still 2026-10-09 in Mexico City: 15 days to 2026-10-24, outside the tier
    const lateEvening = new Date('2026-10-10T03:00:00Z');
    expect(resolveProductPromotion(unit, [], settings, dated('2026-10-24'), lateEvening)).toBeNull();
    // after store midnight (06:00Z) it is 2026-10-10: 14 days, inside
    const afterMidnight = new Date('2026-10-10T06:01:00Z');
    expect(resolveProductPromotion(unit, [], settings, dated('2026-10-24'), afterMidnight)).toMatchObject({
      discountAmount: 15,
    });
  });

  it('an item already past its date is within the tier', () => {
    expect(resolveProductPromotion(unit, [], settings, dated('2026-10-01'), NOW)).toMatchObject({ discountAmount: 15 });
  });
});
