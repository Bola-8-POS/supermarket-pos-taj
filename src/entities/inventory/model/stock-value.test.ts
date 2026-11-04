import { describe, expect, it } from 'vitest';
import {
  computeInventoryValueAsOf,
  groupShrinkageByReason,
} from './queries-analytics';
import { stockValue } from './stock-value';

describe('stockValue', () => {
  it('valuation of a weighed product is grams / 1000 times cost per kg', () => {
    expect(stockValue(2500, 40, true)).toBe(100);
    const [row] = computeInventoryValueAsOf(
      [{ productId: 'w', quantityOnHand: 2500, costPrice: 40, soldByWeight: true }],
      [],
      new Date('2026-08-15T00:00:00.000Z')
    );
    expect(row?.value).toBe(100);
  });

  it("a unit product's value is unchanged", () => {
    expect(stockValue(10, 5, false)).toBe(50);
    const [row] = computeInventoryValueAsOf(
      [{ productId: 'u', quantityOnHand: 10, costPrice: 5, soldByWeight: false }],
      [],
      new Date('2026-08-15T00:00:00.000Z')
    );
    expect(row?.value).toBe(50);
  });

  it('movement value for a weighed product uses the same scale', () => {
    const createdAt = new Date('2026-08-15T00:00:00.000Z');
    const result = groupShrinkageByReason([
      { productId: 'w', quantityDelta: -500, reason: 'waste', costPrice: 40, soldByWeight: true, createdAt },
      { productId: 'u', quantityDelta: -3, reason: 'waste', costPrice: 5, soldByWeight: false, createdAt },
    ]);
    expect(result.get('waste')).toEqual({ units: 503, value: 35 });
  });

  it('stock total sums weighed and unit rows with the right scale', () => {
    const rows = [
      { q: 2500, c: 40, w: true },
      { q: 10, c: 5, w: false },
    ];
    const total = rows.reduce((s, r) => s + stockValue(r.q, r.c, r.w), 0);
    expect(Math.round(total * 100) / 100).toBe(150);
  });
});
