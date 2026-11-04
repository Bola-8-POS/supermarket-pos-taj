import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calculateDiscountAmount } from './domain-helpers';

describe('calculateDiscountAmount rounds like the server', () => {
  it('an ad-hoc percent discount on a half-cent tie rounds like the server', () => {
    // SQL: ROUND(20.70 * 5 / 100, 2) = ROUND(1.035, 2) = 1.04 (naive float math gave 1.03)
    expect(calculateDiscountAmount(20.7, 'percent', 5)).toBe(1.04);
  });

  it('matches an integer-cent reference of numeric ROUND for generated subtotals and percents', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }), // subtotal, cents
        fc.integer({ min: 1, max: 10_000 }), // percent in hundredths
        (cents, hundredths) => {
          const expected = Math.floor((2 * cents * hundredths + 10_000) / 20_000);
          expect(Math.round(calculateDiscountAmount(cents / 100, 'percent', hundredths / 100) * 100)).toBe(
            expected
          );
        }
      ),
      { numRuns: 5000 }
    );
  });
});
