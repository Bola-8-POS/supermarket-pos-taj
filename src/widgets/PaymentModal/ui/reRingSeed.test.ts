import { describe, expect, it } from 'vitest';
import { reRingDiscountSeed } from './reRingSeed';
import { formTotal } from './saleTotals';

const round2 = (n: number) => Math.round(n * 100) / 100;

describe('reRingDiscountSeed', () => {
  it('makes the total equal what the customer paid when the store prices include tax', () => {
    expect(reRingDiscountSeed({ base: 20, paid: 18, taxRatePercent: 16, taxInclusive: true })).toEqual({
      amount: 2,
      total: 18,
    });
  });

  it('seeds the PRE-tax amount in a tax-exclusive store so the taxed total equals what was paid', () => {
    // today 116.00, paid 104.40: a post-tax difference of 11.60 would land on 102.54
    expect(reRingDiscountSeed({ base: 100, paid: 104.4, taxRatePercent: 16, taxInclusive: false })).toEqual({
      amount: 10,
      total: 104.4,
    });
  });

  it('the seeded total never exceeds what the customer paid at any tax rate', () => {
    // the reviewer's case: at 10 % the half-cent tie once put the form one cent ABOVE paid
    const seed = reRingDiscountSeed({ base: 20, paid: 3.13, taxRatePercent: 10, taxInclusive: false });
    expect(seed).not.toBeNull();
    const total = formTotal(20, seed?.amount ?? 0, 0, 10, false);
    expect(total).toBeLessThanOrEqual(3.13);
    expect(seed?.total).toBe(total);

    for (const [rate, inclusive] of [
      [0, false],
      [5, false],
      [7.5, false],
      [8, false],
      [10, false],
      [12.5, false],
      [15, false],
      [16, false],
      [18, false],
      [20, false],
      [5, true],
      [16, true],
    ] as const) {
      const top = Math.round(100 * (inclusive ? 1 : 1 + rate / 100) * 100);
      for (let cents = 1; cents < top; cents += 1) {
        const paid = cents / 100;
        const seed = reRingDiscountSeed({ base: 100, paid, taxRatePercent: rate, taxInclusive: inclusive });
        if (seed === null) continue;
        const real = formTotal(100, seed.amount, 0, rate, inclusive);
        const label = `paid ${String(paid)} @${String(rate)}${inclusive ? ' incl' : ''}`;
        expect(real, label).toBeLessThanOrEqual(paid);
        expect(seed.total, label).toBe(real);
        expect(round2(paid - real), label).toBeLessThan(0.03);
      }
    }
  });

  it('seeds nothing when today is not dearer than what was paid', () => {
    expect(reRingDiscountSeed({ base: 20, paid: 25, taxRatePercent: 0, taxInclusive: true })).toBeNull();
  });
});
