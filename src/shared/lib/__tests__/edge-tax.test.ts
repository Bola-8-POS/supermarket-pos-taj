/**
 * edge-tax.test.ts
 *
 * Unit + property tests for supabase/functions/_shared/tax.ts's decomposeTax,
 * imported directly from a Vitest src/ test (the function has zero imports
 * itself, so it's importable despite living under supabase/functions/, which
 * Vitest's `include` glob does not scan for test files but can still resolve
 * as a plain import target).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decomposeTax } from '../../../../supabase/functions/_shared/tax.ts';

describe('decomposeTax', () => {
  it('inclusive mode: decomposes an already-inclusive total (TAX-02)', () => {
    expect(decomposeTax(116, 16, true)).toEqual({ subtotal: 100, taxAmount: 16, total: 116 });
  });

  it('exclusive mode: backs the additive tax out of an already-charged amount', () => {
    // chargedAmount here is always process_direct_sale_atomic's v_derived_total
    // (subtotal+tax already added on top) — at 116 with a 16% rate, both the
    // inclusive and exclusive decomposition formulas agree on the same 100/16 split.
    expect(decomposeTax(116, 16, false)).toEqual({ subtotal: 100, taxAmount: 16, total: 116 });
  });

  it('property: subtotal + taxAmount === total to the cent, for both modes (Open Question 2)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 100_000, noNaN: true }).map(n => Math.round(n * 100) / 100),
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.boolean(),
        (chargedAmount, taxRatePercent, taxInclusive) => {
          const { subtotal, taxAmount, total } = decomposeTax(
            chargedAmount,
            taxRatePercent,
            taxInclusive
          );
          expect(Math.round((subtotal + taxAmount) * 100)).toBe(Math.round(total * 100));
        }
      )
    );
  });
});
