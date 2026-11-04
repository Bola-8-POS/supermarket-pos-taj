import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { computeReorderQuantity } from './reorder-quantity';

describe('computeReorderQuantity — D-07 top-up + D-08 pack-size rounding', () => {
  test('exactly-at-threshold floors at 0 (D-07)', () => {
    expect(computeReorderQuantity(5, 5, null)).toBe(0);
  });

  test('raw top-up, no rounding when unitsPerPackage is null', () => {
    expect(computeReorderQuantity(3, 10, null)).toBe(7);
  });

  test('raw 7 rounds up to the next multiple of 4', () => {
    expect(computeReorderQuantity(3, 10, 4)).toBe(8);
  });

  test('raw 8 is already an exact multiple of 4 — must NOT over-round to 12', () => {
    expect(computeReorderQuantity(2, 10, 4)).toBe(8);
  });

  test('above threshold — negative raw diff floors at 0, never rounded up to a positive multiple', () => {
    expect(computeReorderQuantity(10, 5, 4)).toBe(0);
  });

  test('property: result is always >= 0, and when unitsPerPackage is positive and result > 0, result is a multiple of it', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000 }),
        fc.nat({ max: 100_000 }),
        fc.option(fc.integer({ min: 1, max: 1000 }), { nil: null }),
        (quantityOnHand, lowStockThreshold, unitsPerPackage) => {
          const result = computeReorderQuantity(quantityOnHand, lowStockThreshold, unitsPerPackage);
          expect(result).toBeGreaterThanOrEqual(0);
          if (unitsPerPackage && unitsPerPackage > 0 && result > 0) {
            expect(result % unitsPerPackage).toBe(0);
          }
        }
      )
    );
  });
});
