/**
 * _shared/tax.ts — mode-aware tax decomposition (Deno runtime)
 *
 * Usage in edge functions:
 *   import { decomposeTax } from '../_shared/tax.ts';
 *   const { subtotal, taxAmount, total } = decomposeTax(chargedAmount, taxRatePercent, taxInclusive);
 *
 * Pure arithmetic, no imports — importable identically from the Deno edge
 * runtime and from a plain Vitest test (see src/shared/lib/__tests__/edge-tax.test.ts).
 *
 * `chargedAmount` is always the amount actually charged (what
 * process_direct_sale_atomic's v_derived_total ended up being), regardless
 * of mode:
 *   - taxInclusive=true: chargedAmount already IS the total (catalog prices
 *     include tax) — subtotal is decomposed backward by division, then
 *     taxAmount by subtraction (never re-derived independently — avoids a
 *     1-cent drift vs. total).
 *   - taxInclusive=false: chargedAmount is subtotal+tax already added on
 *     top — taxAmount is backed out via the standard tax-inclusive-price
 *     formula (amount * rate / (100 + rate)), then subtotal by subtraction.
 */
export function decomposeTax(
  chargedAmount: number,
  taxRatePercent: number,
  taxInclusive: boolean
): { subtotal: number; taxAmount: number; total: number } {
  if (taxInclusive) {
    const subtotal = Math.round((chargedAmount / (1 + taxRatePercent / 100)) * 100) / 100;
    const taxAmount = Math.round((chargedAmount - subtotal) * 100) / 100;
    return { subtotal, taxAmount, total: chargedAmount };
  }
  const taxAmount = Math.round(((chargedAmount * taxRatePercent) / (100 + taxRatePercent)) * 100) / 100;
  const subtotal = Math.round((chargedAmount - taxAmount) * 100) / 100;
  return { subtotal, taxAmount, total: chargedAmount };
}
