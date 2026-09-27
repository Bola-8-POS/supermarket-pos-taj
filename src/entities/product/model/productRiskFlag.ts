import type { Product } from '@shared/lib/domain';

export type ProductRiskFlag = 'zero-price' | 'low-stock' | null;

/**
 * Pure predicate over an already-fetched, active `Product`. Zero-price takes
 * precedence when both conditions hold, so exactly one flag is ever returned
 * (Phase 12 D-02/D-06). A product with no `inventory` row (`quantityOnHand`
 * or `lowStockThreshold` undefined) is never flagged low-stock — fail open,
 * not fail closed (RESEARCH.md Pitfall 2).
 */
export function getProductRiskFlag(product: Product): ProductRiskFlag {
  if (product.basePrice === 0) return 'zero-price';
  if (
    product.quantityOnHand !== undefined &&
    product.lowStockThreshold !== undefined &&
    product.quantityOnHand <= product.lowStockThreshold
  ) {
    return 'low-stock';
  }
  return null;
}
