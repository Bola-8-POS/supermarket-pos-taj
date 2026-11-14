/**
 * D-07/D-08 reorder-quantity formula.
 *
 * D-07: top up to the reorder point, floored at 0 — never suggest a
 * negative or below-zero quantity when stock is already at/above threshold.
 * D-08: when the product has a case/box pack size (`unitsPerPackage`),
 * round the raw top-up up to the nearest whole multiple of it — you're
 * ordering cases from a supplier, not loose units. Falls back to the raw
 * D-07 value when unitsPerPackage is null or non-positive.
 */
export function computeReorderQuantity(
  quantityOnHand: number,
  lowStockThreshold: number,
  unitsPerPackage: number | null
): number {
  const raw = Math.max(0, lowStockThreshold - quantityOnHand);
  if (raw === 0 || !unitsPerPackage || unitsPerPackage <= 0) return raw;
  return Math.ceil(raw / unitsPerPackage) * unitsPerPackage;
}
