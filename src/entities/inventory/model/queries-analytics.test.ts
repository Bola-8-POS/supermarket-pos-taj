/**
 * Unit tests for pure helpers in queries-analytics.ts (Phase 14, Plan 01 — Valuation).
 * Fixture-pinned per 14-01-PLAN.md <behavior>; test names contain "valuation" so
 * `-t valuation` matches per 14-VALIDATION.md.
 */

import { describe, expect, it } from 'vitest';
import { combineTurnoverRows, computeInventoryValueAsOf, groupShrinkageByReason } from './queries-analytics';

describe('valuation: computeInventoryValueAsOf', () => {
  const asOfDate = new Date('2026-08-15T00:00:00.000Z');

  it('valuation: returns quantityAsOf=10, value=50 for one product with zero movements after cutoff', () => {
    const current = [{ productId: 'p1', quantityOnHand: 10, costPrice: 5 }];
    const result = computeInventoryValueAsOf(current, [], asOfDate);
    expect(result).toEqual([{ productId: 'p1', quantityAsOf: 10, costPrice: 5, value: 50 }]);
  });

  it('valuation: defensively subtracts a later movement (quantityDelta=+3 dated after cutoff) to get quantityAsOf=7, value=35', () => {
    const current = [{ productId: 'p1', quantityOnHand: 10, costPrice: 5 }];
    const movements = [
      {
        productId: 'p1',
        quantityDelta: 3,
        createdAt: new Date('2026-08-16T00:00:00.000Z'),
      },
    ];
    const result = computeInventoryValueAsOf(current, movements, asOfDate);
    expect(result).toEqual([{ productId: 'p1', quantityAsOf: 7, costPrice: 5, value: 35 }]);
  });

  it('valuation: ignores a movement with createdAt <= asOfDate even if present in the input array', () => {
    const current = [{ productId: 'p1', quantityOnHand: 10, costPrice: 5 }];
    const movements = [
      { productId: 'p1', quantityDelta: 3, createdAt: asOfDate }, // exactly at cutoff — not "after"
      {
        productId: 'p1',
        quantityDelta: 4,
        createdAt: new Date('2026-08-14T00:00:00.000Z'), // before cutoff
      },
    ];
    const result = computeInventoryValueAsOf(current, movements, asOfDate);
    expect(result).toEqual([{ productId: 'p1', quantityAsOf: 10, costPrice: 5, value: 50 }]);
  });

  it('valuation: returns value=null (never 0) when costPrice is null, regardless of quantityAsOf', () => {
    const current = [{ productId: 'p1', quantityOnHand: 10, costPrice: null }];
    const result = computeInventoryValueAsOf(current, [], asOfDate);
    expect(result).toEqual([{ productId: 'p1', quantityAsOf: 10, costPrice: null, value: null }]);
  });

  it('valuation: aggregates two products independently (a movement for product A never affects product B)', () => {
    const current = [
      { productId: 'p1', quantityOnHand: 10, costPrice: 5 },
      { productId: 'p2', quantityOnHand: 20, costPrice: 2 },
    ];
    const movements = [
      {
        productId: 'p1',
        quantityDelta: 3,
        createdAt: new Date('2026-08-16T00:00:00.000Z'),
      },
    ];
    const result = computeInventoryValueAsOf(current, movements, asOfDate);
    expect(result).toEqual([
      { productId: 'p1', quantityAsOf: 7, costPrice: 5, value: 35 },
      { productId: 'p2', quantityAsOf: 20, costPrice: 2, value: 40 },
    ]);
  });

  it('valuation: idempotency probe — calling twice with identical input returns deep-equal results both times', () => {
    const current = [
      { productId: 'p1', quantityOnHand: 10, costPrice: 5 },
      { productId: 'p2', quantityOnHand: 20, costPrice: null },
    ];
    const movements = [
      {
        productId: 'p1',
        quantityDelta: -2,
        createdAt: new Date('2026-08-16T00:00:00.000Z'),
      },
    ];
    const first = computeInventoryValueAsOf(current, movements, asOfDate);
    const second = computeInventoryValueAsOf(current, movements, asOfDate);
    expect(first).toEqual(second);
  });
});

describe('shrinkage: groupShrinkageByReason', () => {
  const createdAt = new Date('2026-08-15T00:00:00.000Z');

  it('shrinkage: a waste movement with quantityDelta=-3 and costPrice=5 produces a waste bucket { units: 3, value: 15 }', () => {
    const result = groupShrinkageByReason([
      { productId: 'p1', quantityDelta: -3, reason: 'waste', costPrice: 5, createdAt },
    ]);
    expect(result.get('waste')).toEqual({ units: 3, value: 15 });
  });

  it('shrinkage: a correction movement buckets under correction, a manual_adjustment movement buckets under unclassified_adjustments (D-02)', () => {
    const result = groupShrinkageByReason([
      { productId: 'p1', quantityDelta: -2, reason: 'correction', costPrice: 10, createdAt },
      { productId: 'p2', quantityDelta: -1, reason: 'manual_adjustment', costPrice: 4, createdAt },
    ]);
    expect(result.get('correction')).toEqual({ units: 2, value: 20 });
    expect(result.get('unclassified_adjustments')).toEqual({ units: 1, value: 4 });
    expect(result.has('waste')).toBe(false);
    expect(result.has('expired')).toBe(false);
  });

  it('shrinkage: an expired movement buckets under its own expired key, isolated from waste/correction/unclassified', () => {
    const result = groupShrinkageByReason([
      { productId: 'p1', quantityDelta: -4, reason: 'expired', costPrice: 3, createdAt },
    ]);
    expect(result.get('expired')).toEqual({ units: 4, value: 12 });
    expect(result.has('waste')).toBe(false);
    expect(result.has('correction')).toBe(false);
    expect(result.has('unclassified_adjustments')).toBe(false);
  });

  it('shrinkage: sale and refund movements are excluded entirely (neither counted nor bucketed)', () => {
    const result = groupShrinkageByReason([
      { productId: 'p1', quantityDelta: -5, reason: 'sale', costPrice: 5, createdAt },
      { productId: 'p1', quantityDelta: -5, reason: 'refund', costPrice: 5, createdAt },
    ]);
    expect(result.size).toBe(0);
  });

  it('shrinkage: a positive-quantityDelta waste movement is excluded — shrinkage is loss only, regardless of tagged reason', () => {
    const result = groupShrinkageByReason([
      { productId: 'p1', quantityDelta: 3, reason: 'waste', costPrice: 5, createdAt },
    ]);
    expect(result.size).toBe(0);
  });

  it('shrinkage: two waste movements for different products both roll into the same waste bucket (summed across products)', () => {
    const result = groupShrinkageByReason([
      { productId: 'p1', quantityDelta: -3, reason: 'waste', costPrice: 5, createdAt },
      { productId: 'p2', quantityDelta: -2, reason: 'waste', costPrice: 10, createdAt },
    ]);
    expect(result.get('waste')).toEqual({ units: 5, value: 35 });
  });

  it('shrinkage: costPrice=null on a movement contributes 0 to value but still counts toward units', () => {
    const result = groupShrinkageByReason([
      { productId: 'p1', quantityDelta: -3, reason: 'waste', costPrice: null, createdAt },
    ]);
    expect(result.get('waste')).toEqual({ units: 3, value: 0 });
  });

  it('shrinkage: 5 separate manual_adjustment movements produce exactly ONE unclassified_adjustments Map entry with summed units/value (backstop)', () => {
    const movements = Array.from({ length: 5 }, (_, i) => ({
      productId: `p${String(i)}`,
      quantityDelta: -1,
      reason: 'manual_adjustment',
      costPrice: 2,
      createdAt,
    }));
    const result = groupShrinkageByReason(movements);
    expect(result.size).toBe(1);
    expect(result.get('unclassified_adjustments')).toEqual({ units: 5, value: 10 });
  });

  it('shrinkage: idempotency probe — calling twice with identical input returns deep-equal Maps both times (backstop)', () => {
    const movements = [
      { productId: 'p1', quantityDelta: -3, reason: 'waste', costPrice: 5, createdAt },
      { productId: 'p2', quantityDelta: -1, reason: 'expired', costPrice: 2, createdAt },
    ];
    const first = groupShrinkageByReason(movements);
    const second = groupShrinkageByReason(movements);
    expect(first).toEqual(second);
  });
});

describe('turnover: combineTurnoverRows', () => {
  it('turnover: unitsSold=10 with average inventory value 50 produces turnoverRatio=0.2', () => {
    const rows = combineTurnoverRows(
      [{ productId: 'p1', productName: 'Product A', categoryName: 'Cat A', units: 10 }],
      [{ productId: 'p1', value: 50 }],
      [{ productId: 'p1', value: 50 }]
    );
    expect(rows).toEqual([
      {
        productId: 'p1',
        productName: 'Product A',
        categoryName: 'Cat A',
        unitsSold: 10,
        avgValue: 50,
        turnoverRatio: 0.2,
      },
    ]);
  });

  it('turnover: average inventory value of 0 produces turnoverRatio=null (never 0, Infinity, or NaN)', () => {
    const rows = combineTurnoverRows(
      [{ productId: 'p1', productName: 'Product A', categoryName: 'Cat A', units: 5 }],
      [{ productId: 'p1', value: 0 }],
      [{ productId: 'p1', value: 0 }]
    );
    expect(rows[0]?.avgValue).toBe(0);
    expect(rows[0]?.turnoverRatio).toBeNull();
  });

  it('turnover: a null (no recorded cost) average inventory value produces turnoverRatio=null', () => {
    const rows = combineTurnoverRows(
      [{ productId: 'p1', productName: 'Product A', categoryName: 'Cat A', units: 5 }],
      [{ productId: 'p1', value: null }],
      [{ productId: 'p1', value: 60 }]
    );
    expect(rows[0]?.avgValue).toBeNull();
    expect(rows[0]?.turnoverRatio).toBeNull();
  });

  it('turnover: a product present in units-sold data but absent from valuation data still produces one row, with avgValue=null and turnoverRatio=null (never dropped)', () => {
    const rows = combineTurnoverRows(
      [{ productId: 'p1', productName: 'Product A', categoryName: 'Cat A', units: 7 }],
      [],
      []
    );
    expect(rows).toEqual([
      {
        productId: 'p1',
        productName: 'Product A',
        categoryName: 'Cat A',
        unitsSold: 7,
        avgValue: null,
        turnoverRatio: null,
      },
    ]);
  });

  it('turnover: a product present in valuation data but absent from units-sold data still produces one row, with unitsSold=null and turnoverRatio=null (never dropped, never defaulted to 0)', () => {
    const rows = combineTurnoverRows(
      [],
      [{ productId: 'p2', value: 100 }],
      [{ productId: 'p2', value: 60 }]
    );
    expect(rows).toEqual([
      {
        productId: 'p2',
        productName: 'Unknown Product',
        categoryName: 'Uncategorized',
        unitsSold: null,
        avgValue: 80,
        turnoverRatio: null,
      },
    ]);
  });

  it('turnover: average inventory value is the two-point average of valueAsOf(from)=100 and valueAsOf(to)=60, yielding 80', () => {
    const rows = combineTurnoverRows(
      [{ productId: 'p1', productName: 'Product A', categoryName: 'Cat A', units: 8 }],
      [{ productId: 'p1', value: 100 }],
      [{ productId: 'p1', value: 60 }]
    );
    expect(rows[0]?.avgValue).toBe(80);
    expect(rows[0]?.turnoverRatio).toBe(0.1);
  });

  it('turnover: idempotency probe — calling twice with identical fixture input returns deep-equal rows both times', () => {
    const salesRows = [{ productId: 'p1', productName: 'Product A', categoryName: 'Cat A', units: 10 }];
    const valueAtFrom = [{ productId: 'p1', value: 100 }];
    const valueAtTo = [{ productId: 'p1', value: 60 }];
    const first = combineTurnoverRows(salesRows, valueAtFrom, valueAtTo);
    const second = combineTurnoverRows(salesRows, valueAtFrom, valueAtTo);
    expect(first).toEqual(second);
  });
});
