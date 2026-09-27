/**
 * UOM (Unit of Measure) conversion utilities.
 *
 * Conversion is always via the ingredient's purchase_to_base_factor.
 * Phase 3 does NOT use a hardcoded multi-hop conversion table — the factor
 * is stored per ingredient on creation (see C5 locked decision in
 * .planning/feature-expansion-2026q2/01-locked-decisions.md).
 *
 * Well-known factor relationships (informational only, not hardcoded):
 *   kg → g    : factor = 1000
 *   L  → ml   : factor = 1000
 *   case_24 → unit : factor = 24
 *
 * Precision: arithmetic uses JS number (IEEE 754). Assert results within
 * 1e-6 epsilon in property tests — see P5 in uom.test.ts.
 *
 * Examples:
 *   toBase(2, 1000)       // 2 kg → 2000 g
 *   fromBase(500, 1000)   // 500 g → 0.5 kg
 *   roundTrip(7.3, 1000)  // 7.3 kg → 7300 g → 7.3 kg ≈ 7.3
 */

/** Base UOM values. These are the smallest units stored per ingredient. Does not include case_24. */
export const BASE_UOMS = ['g', 'kg', 'ml', 'L', 'unit', 'portion'] as const;

/** All UOM values including purchase-only units (case_24). */
export const ALL_UOMS = ['g', 'kg', 'ml', 'L', 'unit', 'case_24', 'portion'] as const;

/**
 * Convert a quantity expressed in purchase units to base units.
 * @param purchaseQty - Quantity in purchase units (e.g. 2 for 2 kg)
 * @param purchaseToBaseFactor - Factor stored on the ingredient (e.g. 1000 for kg→g)
 * @returns Quantity in base units (e.g. 2000 for 2000 g)
 */
export function toBase(purchaseQty: number, purchaseToBaseFactor: number): number {
  return purchaseQty * purchaseToBaseFactor;
}

/**
 * Convert a quantity expressed in base units to purchase units.
 * @param baseQty - Quantity in base units (e.g. 2000 for 2000 g)
 * @param purchaseToBaseFactor - Factor stored on the ingredient (e.g. 1000 for kg→g)
 * @returns Quantity in purchase units (e.g. 2 for 2 kg)
 * @throws Error if purchaseToBaseFactor is 0
 */
export function fromBase(baseQty: number, purchaseToBaseFactor: number): number {
  if (purchaseToBaseFactor === 0) {
    throw new Error('purchaseToBaseFactor cannot be 0');
  }
  return baseQty / purchaseToBaseFactor;
}

/**
 * Round-trip identity helper: fromBase(toBase(x, f), f).
 * Used in P5 property test to assert round-trip ≈ identity.
 */
export function roundTrip(x: number, factor: number): number {
  return fromBase(toBase(x, factor), factor);
}
