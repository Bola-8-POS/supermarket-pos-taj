import type { Product } from '@shared/lib/domain';

/** Exact match on name (case-insensitive), barcode, or SKU. */
export function findProductByLookup(products: readonly Product[], search: string): Product | null {
  const needle = search.trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();
  return (
    products.find(
      p => p.name.toLowerCase() === lower || p.barcode === needle || p.sku === needle
    ) ?? null
  );
}
