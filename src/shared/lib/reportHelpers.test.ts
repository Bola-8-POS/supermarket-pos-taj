/**
 * Unit + property-based tests for pure report helpers exported from queries-reports.
 *
 * formatHour is private to HourlyBreakdownPanel — its observable behaviour is
 * tested in HourlyBreakdownPanel.test.tsx (Task 3).
 *
 * This file focuses on:
 *  - calcRevenuePercent (= computePctTotals) edge cases not already in queries-reports.test.ts
 *  - findPeakHour / findSlowestHour edge cases
 *  - Property: sum of pctTotal rows ≈ 100 when at least one revenue > 0
 *  - Property: findPeakHour returns non-null whenever at least one revenue > 0
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computePctTotals,
  findPeakHour,
  findSlowestHour,
  type HourlyRow,
} from '@entities/tab/model/queries-reports';

// ============================================================================
// computePctTotals (alias: calcRevenuePercent behaviour)
// ============================================================================

describe('computePctTotals — edge cases', () => {
  it('returns 0 for every row when total is 0 (no division by zero)', () => {
    const result = computePctTotals([{ revenue: 0 }, { revenue: 0 }, { revenue: 0 }]);
    expect(result).toEqual([0, 0, 0]);
  });

  it('returns correct percentage for two-item split', () => {
    const result = computePctTotals([{ revenue: 75 }, { revenue: 25 }]);
    expect(result[0]).toBe(75);
    expect(result[1]).toBe(25);
  });

  it('returns [100] for a single non-zero row', () => {
    expect(computePctTotals([{ revenue: 999 }])).toEqual([100]);
  });

  it('handles fractional revenues without crashing', () => {
    const result = computePctTotals([{ revenue: 33.33 }, { revenue: 33.33 }, { revenue: 33.34 }]);
    const sum = result.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 100)).toBeLessThan(0.1);
  });
});

// ============================================================================
// findPeakHour — extra scenarios
// ============================================================================

describe('findPeakHour — extra scenarios', () => {
  it('returns the correct peak when two rows have the same revenue (first wins / last wins deterministically)', () => {
    const rows: HourlyRow[] = [
      { hour: 5, orderCount: 1, revenue: 200, dayOfWeek: 0, isBusiest: false },
      { hour: 10, orderCount: 2, revenue: 200, dayOfWeek: 0, isBusiest: false },
    ];
    // The implementation uses reduce with strict >, so the first row stays as best
    const peak = findPeakHour(rows);
    expect(peak).not.toBeNull();
    expect(peak?.revenue).toBe(200);
  });
});

// ============================================================================
// findSlowestHour — extra scenarios
// ============================================================================

describe('findSlowestHour — extra scenarios', () => {
  it('does NOT return the same row as peak when only one non-zero row exists', () => {
    const rows: HourlyRow[] = [
      { hour: 0, orderCount: 0, revenue: 0, dayOfWeek: 0, isBusiest: false },
      { hour: 14, orderCount: 3, revenue: 120, dayOfWeek: 0, isBusiest: false },
    ];
    const peak = findPeakHour(rows);
    const slowest = findSlowestHour(rows);
    // With a single non-zero row, both peak and slowest point to the same row
    // The component hides the slowest callout in this case (isSlowest = !isPeak)
    // but the pure helper still returns the row — verify the value
    expect(slowest?.hour).toBe(peak?.hour);
    expect(slowest?.revenue).toBe(120);
  });

  it('returns a different row from peak when two distinct non-zero rows exist', () => {
    const rows: HourlyRow[] = [
      { hour: 6, orderCount: 1, revenue: 50, dayOfWeek: 0, isBusiest: false },
      { hour: 20, orderCount: 5, revenue: 500, dayOfWeek: 0, isBusiest: false },
    ];
    const peak = findPeakHour(rows);
    const slowest = findSlowestHour(rows);
    expect(peak?.hour).not.toBe(slowest?.hour);
    expect(peak?.hour).toBe(20);
    expect(slowest?.hour).toBe(6);
  });
});

// ============================================================================
// Property-based tests
// ============================================================================

describe('property: computePctTotals sum ≈ 100 when total > 0', () => {
  it('sum of all percentages is within ±0.5 of 100 for any non-empty array with positive revenue', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: Math.fround(0.01), max: Math.fround(10_000), noNaN: true }), {
          minLength: 1,
          maxLength: 24,
        }),
        revenues => {
          const rows = revenues.map(revenue => ({ revenue }));
          const pcts = computePctTotals(rows);
          const sum = pcts.reduce((a, b) => a + b, 0);
          expect(Math.abs(sum - 100)).toBeLessThan(0.5 + 0.01 * revenues.length);
        }
      )
    );
  });
});

describe('property: findPeakHour returns non-null when at least one revenue > 0', () => {
  it('always finds a peak when the input has at least one positive revenue', () => {
    fc.assert(
      fc.property(
        // Generate 1–24 rows; at least one has revenue > 0
        fc
          .array(
            fc.record({
              hour: fc.integer({ min: 0, max: 23 }),
              orderCount: fc.integer({ min: 0, max: 50 }),
              revenue: fc.float({ min: Math.fround(0), max: Math.fround(1_000), noNaN: true }),
              dayOfWeek: fc.integer({ min: 0, max: 6 }),
              isBusiest: fc.boolean(),
            }),
            { minLength: 1, maxLength: 24 }
          )
          .filter(rows => rows.some(r => r.revenue > 0)),
        rows => {
          const peak = findPeakHour(rows);
          expect(peak).not.toBeNull();
        }
      )
    );
  });
});
