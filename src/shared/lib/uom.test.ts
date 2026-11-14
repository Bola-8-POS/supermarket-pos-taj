import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { ALL_UOMS, BASE_UOMS, fromBase, roundTrip, toBase } from './uom';

describe('uom — toBase', () => {
  test('1 kg with factor 1000 → 1000 g', () => {
    expect(toBase(1, 1000)).toBe(1000);
  });

  test('2.5 cases with factor 24 → 60 units', () => {
    expect(toBase(2.5, 24)).toBe(60);
  });

  test('0 purchase qty → 0 base qty', () => {
    expect(toBase(0, 500)).toBe(0);
  });

  test('factor 1 is identity', () => {
    expect(toBase(42, 1)).toBe(42);
  });
});

describe('uom — fromBase', () => {
  test('1000 g with factor 1000 → 1 kg', () => {
    expect(fromBase(1000, 1000)).toBe(1);
  });

  test('0 base qty → 0 purchase qty', () => {
    expect(fromBase(0, 1000)).toBe(0);
  });

  test('factor 1 is identity', () => {
    expect(fromBase(99, 1)).toBe(99);
  });

  test('throws on factor 0', () => {
    expect(() => fromBase(100, 0)).toThrow('purchaseToBaseFactor cannot be 0');
  });
});

describe('uom — constants', () => {
  test('BASE_UOMS includes g, ml, unit but not case_24', () => {
    expect(BASE_UOMS).toContain('g');
    expect(BASE_UOMS).toContain('ml');
    expect(BASE_UOMS).toContain('unit');
    expect(BASE_UOMS).not.toContain('case_24');
  });

  test('ALL_UOMS includes case_24', () => {
    expect(ALL_UOMS).toContain('case_24');
  });
});

// ============================================================================
// P5 — UOM round-trip identity (property test)
// For any qty > 0 and factor > 0: fromBase(toBase(qty, f), f) ≈ qty within 1e-6
// ============================================================================
test('P5: UOM round-trip identity', () => {
  fc.assert(
    fc.property(
      fc.float({ min: Math.fround(0.001), max: Math.fround(1_000_000), noNaN: true }),
      fc.float({ min: Math.fround(0.001), max: Math.fround(10_000), noNaN: true }),
      (qty, factor) => {
        const result = roundTrip(qty, factor);
        expect(Math.abs(result - qty)).toBeLessThan(1e-6);
      },
    ),
    { numRuns: 1000 },
  );
});
