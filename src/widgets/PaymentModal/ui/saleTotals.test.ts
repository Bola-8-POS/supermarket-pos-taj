import { describe, expect, it } from 'vitest';
import { formTotal, saleTaxAmount, saleTotal } from './saleTotals';

describe('saleTotals rounding', () => {
  it('half-cent ties round like SQL ROUND (away from zero)', () => {
    // exclusive: 16% of 0.03 = 0.0048 -> 0.00; of 0.0625-ish ties: 0.25 * 2% = 0.005 -> 0.01
    expect(saleTaxAmount(0.25, 2, false)).toBe(0.01);
    expect(saleTotal(0.25, saleTaxAmount(0.25, 2, false), false)).toBe(0.26);
    // inclusive: 1.005 as the after-discount amount stays a tie the way SQL sees it
    expect(formTotal(1.005, 0, 0, 0, true)).toBe(1.01);
  });
});
