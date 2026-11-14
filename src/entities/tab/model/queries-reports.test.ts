/**
 * Unit tests for pure helpers in queries-reports.ts
 * Uses fast-check for property-based tests on all four helpers.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computePctTotals,
  fillMissingHours,
  fillMissingCategories,
  aggregateCategoryRevenue,
  aggregateHourlyRevenue,
  findPeakHour,
  findSlowestHour,
  filterVoidRefundRows,
  assertDateRangeValid,
  type HourlyRow,
  type VoidRefundRow,
} from './queries-reports';

// ---------------------------------------------------------------------------
// computePctTotals
// ---------------------------------------------------------------------------

describe('computePctTotals', () => {
  it('returns correct percentages for [80, 20]', () => {
    const result = computePctTotals([{ revenue: 80 }, { revenue: 20 }]);
    expect(result).toEqual([80, 20]);
  });

  it('returns [0, 0] when all revenues are zero (no division by zero)', () => {
    const result = computePctTotals([{ revenue: 0 }, { revenue: 0 }]);
    expect(result).toEqual([0, 0]);
  });

  it('returns [100] for a single product', () => {
    const result = computePctTotals([{ revenue: 500 }]);
    expect(result).toEqual([100]);
  });

  it('returns empty array for empty input', () => {
    expect(computePctTotals([])).toEqual([]);
  });

  it('property: sum of pctTotal ≈ 100 when total > 0, else 0', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, max: 10_000, noNaN: true }), {
          minLength: 1,
          maxLength: 20,
        }),
        revenues => {
          const rows = revenues.map(revenue => ({ revenue }));
          const pcts = computePctTotals(rows);
          const sum = pcts.reduce((a, b) => a + b, 0);
          const total = revenues.reduce((a, b) => a + b, 0);
          if (total === 0) {
            expect(sum).toBe(0);
          } else {
            // Allow for rounding to 2 dp: error ≤ 0.01 * n items
            expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01 * revenues.length + 0.01);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// fillMissingHours
// ---------------------------------------------------------------------------

describe('fillMissingHours', () => {
  it('produces exactly 24 entries from 3-hour sparse input', () => {
    const sparse: HourlyRow[] = [
      { hour: 0, orderCount: 5, revenue: 100, dayOfWeek: 0, isBusiest: false },
      { hour: 8, orderCount: 3, revenue: 60, dayOfWeek: 0, isBusiest: false },
      { hour: 21, orderCount: 10, revenue: 200, dayOfWeek: 0, isBusiest: false },
    ];
    const result = fillMissingHours(sparse);
    expect(result).toHaveLength(24);
  });

  it('fills missing hours with revenue 0 and orderCount 0', () => {
    const sparse: HourlyRow[] = [
      { hour: 12, orderCount: 2, revenue: 50, dayOfWeek: 0, isBusiest: false },
    ];
    const result = fillMissingHours(sparse);
    const hour0 = result.find(r => r.hour === 0);
    expect(hour0).toEqual({ hour: 0, orderCount: 0, revenue: 0, dayOfWeek: 0, isBusiest: false });
  });

  it('preserves existing hour data', () => {
    const sparse: HourlyRow[] = [
      { hour: 21, orderCount: 10, revenue: 200, dayOfWeek: 0, isBusiest: false },
    ];
    const result = fillMissingHours(sparse);
    const hour21 = result.find(r => r.hour === 21);
    expect(hour21).toEqual({
      hour: 21,
      orderCount: 10,
      revenue: 200,
      dayOfWeek: 0,
      isBusiest: false,
    });
  });

  it('returns sorted hours 0–23', () => {
    const result = fillMissingHours([]);
    const hours = result.map(r => r.hour);
    expect(hours).toEqual([...Array(24).keys()]);
  });

  it('property: output always has exactly 24 entries with each hour 0–23 appearing once', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 23 }), {
          minLength: 0,
          maxLength: 24,
        }),
        inputHours => {
          const sparse: HourlyRow[] = inputHours.map(h => ({
            hour: h,
            orderCount: 1,
            revenue: 50,
            dayOfWeek: 0,
            isBusiest: false,
          }));
          const result = fillMissingHours(sparse);

          expect(result).toHaveLength(24);

          const outputHours = result.map(r => r.hour).sort((a, b) => a - b);
          expect(outputHours).toEqual([...Array(24).keys()]);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// findPeakHour
// ---------------------------------------------------------------------------

describe('findPeakHour', () => {
  it('returns the hour with highest revenue', () => {
    const rows: HourlyRow[] = [
      { hour: 8, orderCount: 2, revenue: 100, dayOfWeek: 0, isBusiest: false },
      { hour: 21, orderCount: 5, revenue: 400, dayOfWeek: 0, isBusiest: false },
      { hour: 14, orderCount: 3, revenue: 200, dayOfWeek: 0, isBusiest: false },
    ];
    const peak = findPeakHour(rows);
    expect(peak?.hour).toBe(21);
    expect(peak?.revenue).toBe(400);
  });

  it('returns null when all revenues are zero', () => {
    const rows: HourlyRow[] = fillMissingHours([]);
    expect(findPeakHour(rows)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(findPeakHour([])).toBeNull();
  });

  it('returns the single non-zero row when only one row has revenue', () => {
    const rows: HourlyRow[] = [
      { hour: 0, orderCount: 0, revenue: 0, dayOfWeek: 0, isBusiest: false },
      { hour: 15, orderCount: 3, revenue: 90, dayOfWeek: 0, isBusiest: false },
    ];
    const peak = findPeakHour(rows);
    expect(peak?.hour).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// findSlowestHour
// ---------------------------------------------------------------------------

describe('findSlowestHour', () => {
  it('returns the lowest revenue NON-ZERO hour', () => {
    const rows: HourlyRow[] = [
      { hour: 8, orderCount: 2, revenue: 50, dayOfWeek: 0, isBusiest: false },
      { hour: 21, orderCount: 5, revenue: 400, dayOfWeek: 0, isBusiest: false },
      { hour: 14, orderCount: 3, revenue: 200, dayOfWeek: 0, isBusiest: false },
    ];
    const slowest = findSlowestHour(rows);
    expect(slowest?.hour).toBe(8);
    expect(slowest?.revenue).toBe(50);
  });

  it('skips zero-revenue hours', () => {
    const rows: HourlyRow[] = [
      { hour: 0, orderCount: 0, revenue: 0, dayOfWeek: 0, isBusiest: false },
      { hour: 8, orderCount: 2, revenue: 50, dayOfWeek: 0, isBusiest: false },
      { hour: 21, orderCount: 5, revenue: 400, dayOfWeek: 0, isBusiest: false },
    ];
    const slowest = findSlowestHour(rows);
    // hour 0 is zero — should be skipped; hour 8 is lowest non-zero
    expect(slowest?.hour).toBe(8);
  });

  it('returns null when all revenues are zero', () => {
    const rows: HourlyRow[] = fillMissingHours([]);
    expect(findSlowestHour(rows)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(findSlowestHour([])).toBeNull();
  });

  it('returns the only non-zero row when only one has revenue', () => {
    const rows: HourlyRow[] = [
      { hour: 2, orderCount: 0, revenue: 0, dayOfWeek: 0, isBusiest: false },
      { hour: 9, orderCount: 1, revenue: 75, dayOfWeek: 0, isBusiest: false },
    ];
    const slowest = findSlowestHour(rows);
    expect(slowest?.hour).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// filterVoidRefundRows
// ---------------------------------------------------------------------------

function makeVoidRow(overrides: Partial<VoidRefundRow> = {}): VoidRefundRow {
  return {
    orderId: '00000000-0000-0000-0000-000000000001',
    voidedAt: new Date('2026-04-21T12:00:00Z'),
    staffName: 'Alice',
    amount: 25,
    reason: 'Wrong order',
    ...overrides,
  };
}

describe('filterVoidRefundRows', () => {
  const from = new Date('2026-04-21T00:00:00Z');
  const to = new Date('2026-04-21T23:59:59Z');

  it('keeps rows whose voidedAt is within the range (inclusive)', () => {
    const rows: VoidRefundRow[] = [
      makeVoidRow({
        orderId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        voidedAt: new Date('2026-04-21T08:00:00Z'),
      }),
      makeVoidRow({
        orderId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        voidedAt: new Date('2026-04-21T20:00:00Z'),
      }),
    ];
    const result = filterVoidRefundRows(rows, from, to);
    expect(result).toHaveLength(2);
  });

  it('excludes rows outside the range', () => {
    const rows: VoidRefundRow[] = [
      makeVoidRow({
        orderId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        voidedAt: new Date('2026-04-20T23:59:59Z'),
      }),
      makeVoidRow({
        orderId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        voidedAt: new Date('2026-04-22T00:00:01Z'),
      }),
    ];
    const result = filterVoidRefundRows(rows, from, to);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when input is empty', () => {
    expect(filterVoidRefundRows([], from, to)).toEqual([]);
  });

  it('property: filtered rows all have voidedAt within [from, to]', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            orderId: fc.constant('00000000-0000-0000-0000-000000000001'),
            voidedAt: fc.date({ min: new Date('2026-01-01'), max: new Date('2026-12-31') }),
            staffName: fc.string(),
            amount: fc.float({ min: 0, max: 500, noNaN: true }),
            reason: fc.string(),
          }),
          { minLength: 0, maxLength: 20 }
        ),
        rows => {
          const filtered = filterVoidRefundRows(rows, from, to);
          return filtered.every(r => r.voidedAt >= from && r.voidedAt <= to);
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// fillMissingCategories
// ---------------------------------------------------------------------------

const ALL_CATS = [
  { id: 'pool', name: 'Pool' },
  { id: 'beer', name: 'Beer' },
  { id: 'cocktails', name: 'Cocktails' },
];

describe('fillMissingCategories', () => {
  it('returns all canonical categories when rows are empty (zero-revenue fill)', () => {
    const result = fillMissingCategories([], ALL_CATS);
    expect(result).toHaveLength(3);
    const poolRow = result.find(r => r.categoryId === 'pool');
    expect(poolRow).toEqual({
      categoryId: 'pool',
      categoryName: 'Pool',
      unitsSold: 0,
      orderCount: 0,
      revenue: 0,
    });
  });

  it('preserves revenue for categories that have sales', () => {
    const rows = [
      { categoryId: 'beer', categoryName: 'Beer', unitsSold: 10, orderCount: 5, revenue: 100 },
    ];
    const result = fillMissingCategories(rows, ALL_CATS);
    const beerRow = result.find(r => r.categoryId === 'beer');
    expect(beerRow?.revenue).toBe(100);
    expect(beerRow?.unitsSold).toBe(10);
  });

  it('fills missing categories with $0.00 while preserving present ones', () => {
    const rows = [
      { categoryId: 'beer', categoryName: 'Beer', unitsSold: 5, orderCount: 3, revenue: 50 },
    ];
    const result = fillMissingCategories(rows, ALL_CATS);
    expect(result).toHaveLength(3);
    const cocktailsRow = result.find(r => r.categoryId === 'cocktails');
    expect(cocktailsRow).toEqual({
      categoryId: 'cocktails',
      categoryName: 'Cocktails',
      unitsSold: 0,
      orderCount: 0,
      revenue: 0,
    });
  });

  it('sorts by revenue descending', () => {
    const rows = [
      {
        categoryId: 'cocktails',
        categoryName: 'Cocktails',
        unitsSold: 5,
        orderCount: 5,
        revenue: 200,
      },
      { categoryId: 'beer', categoryName: 'Beer', unitsSold: 10, orderCount: 8, revenue: 100 },
    ];
    const result = fillMissingCategories(rows, ALL_CATS);
    expect(result[0]?.categoryId).toBe('cocktails');
    expect(result[1]?.categoryId).toBe('beer');
    expect(result[2]?.revenue).toBe(0);
  });

  it('property: output always contains every canonical category', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('pool', 'beer', 'cocktails'), { minLength: 0, maxLength: 3 }),
        presentIds => {
          const uniqueIds = [...new Set(presentIds)];
          const rows = uniqueIds.map(id => ({
            categoryId: id,
            categoryName: id,
            unitsSold: 1,
            orderCount: 1,
            revenue: 50,
          }));
          const result = fillMissingCategories(rows, ALL_CATS);
          expect(result).toHaveLength(ALL_CATS.length);
          for (const cat of ALL_CATS) {
            expect(result.some(r => r.categoryId === cat.id)).toBe(true);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// aggregateCategoryRevenue — AC-5: pool sessions → 'pool', products → their category
// ---------------------------------------------------------------------------

function makeItem(opts: {
  categoryId: string;
  categoryName: string;
  quantity: number;
  unit_price: number;
  modifier_price_delta?: number;
}) {
  return {
    quantity: opts.quantity,
    unit_price: opts.unit_price,
    modifier_price_delta: opts.modifier_price_delta ?? 0,
    products: {
      categories: { id: opts.categoryId, name: opts.categoryName },
    },
  };
}

describe('aggregateCategoryRevenue', () => {
  it('assigns pool session items to the pool category bucket', () => {
    const items = [
      makeItem({ categoryId: 'pool', categoryName: 'Pool', quantity: 1, unit_price: 50 }),
      makeItem({ categoryId: 'pool', categoryName: 'Pool', quantity: 1, unit_price: 30 }),
    ];
    const result = aggregateCategoryRevenue(items);
    const poolRow = result.find(r => r.categoryId === 'pool');
    expect(poolRow?.revenue).toBe(80);
    expect(poolRow?.unitsSold).toBe(2);
    expect(poolRow?.orderCount).toBe(2);
  });

  it('assigns product sales to their category mapping', () => {
    const items = [
      makeItem({ categoryId: 'beer', categoryName: 'Beer', quantity: 3, unit_price: 10 }),
      makeItem({ categoryId: 'cocktails', categoryName: 'Cocktails', quantity: 2, unit_price: 15 }),
      makeItem({ categoryId: 'beer', categoryName: 'Beer', quantity: 1, unit_price: 10 }),
    ];
    const result = aggregateCategoryRevenue(items);
    const beerRow = result.find(r => r.categoryId === 'beer');
    const cocktailsRow = result.find(r => r.categoryId === 'cocktails');
    expect(beerRow?.revenue).toBe(40);
    expect(beerRow?.unitsSold).toBe(4);
    expect(cocktailsRow?.revenue).toBe(30);
    expect(cocktailsRow?.unitsSold).toBe(2);
  });

  it('correctly applies modifier_price_delta to line revenue', () => {
    const items = [
      makeItem({
        categoryId: 'beer',
        categoryName: 'Beer',
        quantity: 2,
        unit_price: 10,
        modifier_price_delta: 2,
      }),
    ];
    const result = aggregateCategoryRevenue(items);
    // 2 × (10 + 2) = 24
    expect(result.find(r => r.categoryId === 'beer')?.revenue).toBe(24);
  });

  it('produces separate rows for pool vs product categories', () => {
    const items = [
      makeItem({ categoryId: 'pool', categoryName: 'Pool', quantity: 1, unit_price: 60 }),
      makeItem({ categoryId: 'beer', categoryName: 'Beer', quantity: 4, unit_price: 10 }),
    ];
    const result = aggregateCategoryRevenue(items);
    expect(result).toHaveLength(2);
    expect(result.some(r => r.categoryId === 'pool')).toBe(true);
    expect(result.some(r => r.categoryId === 'beer')).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(aggregateCategoryRevenue([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// aggregateHourlyRevenue — AC: day-boundary bucketing
// ---------------------------------------------------------------------------

function makeHourlyItem(createdAt: Date, unitPrice: number) {
  return {
    orders: { created_at: createdAt.toISOString() },
    quantity: 1,
    unit_price: unitPrice,
    modifier_price_delta: 0,
  };
}

describe('aggregateHourlyRevenue', () => {
  it('buckets items at 23:59 and 00:01 into separate hours across a day boundary', () => {
    // Use Date constructor (local time) so getHours() is consistent with new Date(iso).getHours()
    const lateNight = new Date(2026, 3, 21, 23, 59, 0); // local 23:59
    const earlyMorning = new Date(2026, 3, 22, 0, 1, 0); // local 00:01 next day

    const items = [makeHourlyItem(lateNight, 10), makeHourlyItem(earlyMorning, 20)];

    const sparse = aggregateHourlyRevenue(items);

    // Both timestamps are constructed and parsed with the same local timezone,
    // so hour extraction is consistent regardless of the test environment's TZ.
    const h23 = sparse.find(r => r.hour === lateNight.getHours());
    const h0 = sparse.find(r => r.hour === earlyMorning.getHours());

    expect(h23?.revenue).toBe(10);
    expect(h0?.revenue).toBe(20);
    // The two items must land in different buckets (23 ≠ 0)
    expect(lateNight.getHours()).not.toBe(earlyMorning.getHours());
  });

  it('accumulates revenue and order count for multiple items in the same hour', () => {
    const noon = new Date(2026, 3, 21, 12, 0, 0);
    const noonLate = new Date(2026, 3, 21, 12, 45, 0);

    const items = [makeHourlyItem(noon, 15), makeHourlyItem(noonLate, 25)];
    const sparse = aggregateHourlyRevenue(items);
    const h12 = sparse.find(r => r.hour === 12);

    expect(h12?.revenue).toBe(40);
    expect(h12?.orderCount).toBe(2);
  });

  it('skips items with no orders.created_at', () => {
    const items = [{ orders: null, quantity: 1, unit_price: 50, modifier_price_delta: 0 }];
    const sparse = aggregateHourlyRevenue(items);
    expect(sparse).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(aggregateHourlyRevenue([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// assertDateRangeValid — Phase 8 365-day guard
// ---------------------------------------------------------------------------

describe('assertDateRangeValid', () => {
  it('does not throw for a 30-day range', () => {
    const from = new Date('2026-04-01');
    const to = new Date('2026-05-01');
    expect(() => { assertDateRangeValid(from, to); }).not.toThrow();
  });

  it('does not throw for exactly 365 days', () => {
    const from = new Date('2025-05-01');
    const to = new Date('2026-05-01');
    expect(() => { assertDateRangeValid(from, to); }).not.toThrow();
  });

  it('throws for 366 days', () => {
    const from = new Date('2025-04-30');
    const to = new Date('2026-05-01');
    expect(() => { assertDateRangeValid(from, to); }).toThrow('365 days');
  });

  it('throws for reversed range > 365 days (uses Math.abs)', () => {
    const from = new Date('2026-05-01');
    const to = new Date('2025-04-30');
    expect(() => { assertDateRangeValid(from, to); }).toThrow('365 days');
  });
});
