import { describe, expect, it } from 'vitest';
import { priceAfterPercentOff } from './price-math';

describe('priceAfterPercentOff (whole cents, half-up)', () => {
  it('10% of 330.00 is 297.00', () => {
    expect(priceAfterPercentOff(330, 10)).toBe(29700);
  });
  it('15% off 99.99 is 84.99 (84.9915 rounds to the cent)', () => {
    expect(priceAfterPercentOff(99.99, 15)).toBe(8499);
  });
  it('rounds a half cent up', () => {
    expect(priceAfterPercentOff(0.1, 5)).toBe(10); // 9.5 cents -> 10
    expect(priceAfterPercentOff(10.1, 50)).toBe(505);
  });
  it('is not fooled by float noise (1.15 * 100 = 114.99999999999999)', () => {
    expect(priceAfterPercentOff(1.15, 10)).toBe(104); // 115 * 0.9 = 103.5 -> 104
  });
  it('is null when the price would drop below one cent or the input is invalid', () => {
    expect(priceAfterPercentOff(0.01, 90)).toBeNull();
    expect(priceAfterPercentOff(0, 10)).toBeNull();
    expect(priceAfterPercentOff(10, 0)).toBeNull();
    expect(priceAfterPercentOff(10, 2.5)).toBeNull();
  });
});
