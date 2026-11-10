import { useInventory, useNearExpiryPricingDates } from '@entities/inventory';
import { useProducts } from '@entities/product';
import { resolveProductPromotion, usePromotions } from '@entities/promotion';
import { useSettings } from '@entities/settings';
import { calcWeightedLineTotal } from '@entities/tab/model/cartStore';
import type { CartItem } from '@shared/lib/domain';

/** What the catalog says now for one restored line. Price is integer cents (line total if weighed). */
export interface CurrentValues {
  priceCents: number;
  promotionId: string | null;
  /** null = stock is not tracked for this product. */
  stock: number | null;
}

export type BasketConflictKind = 'price' | 'promotion' | 'stock' | 'unavailable';

/**
 * One saved-versus-current difference. price/promotion: cents of the effective price (a weighed
 * line's line total); stock: quantities; unavailable: current is null.
 * `key` includes the current value, so accepting it never covers a later change.
 */
export interface BasketConflict {
  key: string;
  lineId: string;
  productName: string;
  kind: BasketConflictKind;
  saved: number | null;
  current: number | null;
}

const toCents = (amount: number) => Math.round(amount * 100);

/**
 * D-03 detection. Pure: builds new conflict objects only and never returns or mutates a line, so a
 * current catalog value can never leak into the saved snapshot. Integer cents compare exactly in
 * both directions. A null map, or a line missing from it, is "unavailable", never a match.
 */
export function findBasketConflicts(
  items: ReadonlyArray<CartItem>,
  current: ReadonlyMap<string, CurrentValues> | null
): BasketConflict[] {
  // Stock is checked against everything of that product in the basket (weighed lines excluded:
  // their unit is grams, not stock units).
  const wanted = new Map<string, number>();
  for (const item of items) {
    if (item.weightGrams != null) continue;
    wanted.set(item.product.id, (wanted.get(item.product.id) ?? 0) + item.quantity);
  }

  const conflicts: BasketConflict[] = [];
  for (const item of items) {
    const base = { lineId: item.tempId, productName: item.product.name };
    const now = current?.get(item.tempId);
    if (!now) {
      conflicts.push({ ...base, key: `${item.tempId}:unavailable`, kind: 'unavailable', saved: null, current: null });
      continue;
    }
    const savedCents = toCents(item.weightGrams != null ? item.lineTotal : item.unitPrice);
    if (savedCents !== now.priceCents) {
      conflicts.push({
        ...base,
        key: `${item.tempId}:price:${String(now.priceCents)}`,
        kind: 'price',
        saved: savedCents,
        current: now.priceCents,
      });
    }
    if ((item.promotionId ?? null) !== now.promotionId) {
      conflicts.push({
        ...base,
        key: `${item.tempId}:promotion:${now.promotionId ?? 'none'}`,
        kind: 'promotion',
        saved: savedCents,
        current: now.priceCents,
      });
    }
    const quantity = wanted.get(item.product.id) ?? 0;
    if (item.weightGrams == null && now.stock !== null && now.stock < quantity) {
      conflicts.push({
        ...base,
        key: `${item.tempId}:stock:${String(now.stock)}`,
        kind: 'stock',
        saved: quantity,
        current: now.stock,
      });
    }
  }
  return conflicts;
}

/**
 * Current values from the sources the cart's add path already uses (products, promotions,
 * settings, near-expiry dates) plus the inventory list. No new query key. `loading` until every
 * source has answered; any failed source reads as unavailable (null map).
 */
export function useBasketConflicts(items: ReadonlyArray<CartItem>): {
  conflicts: BasketConflict[];
  loading: boolean;
} {
  const products = useProducts();
  const promotions = usePromotions();
  const settings = useSettings();
  const nearExpiry = useNearExpiryPricingDates();
  const inventory = useInventory();

  const sources = [products, promotions, settings, nearExpiry, inventory];
  const failed = sources.some(
    source => source.isError || ('resultError' in source && source.resultError !== undefined)
  );
  const loading = !failed && sources.some(source => source.data === undefined);

  if (loading) return { conflicts: [], loading: true };
  if (failed || !products.data || !promotions.data || !settings.data || !nearExpiry.data || !inventory.data) {
    return { conflicts: findBasketConflicts(items, null), loading: false };
  }

  const catalog = new Map(products.data.map(product => [product.id, product]));
  const stockByProduct = new Map(inventory.data.map(row => [row.productId, row.quantityOnHand]));
  const values = new Map<string, CurrentValues>();
  for (const item of items) {
    const product = catalog.get(item.product.id);
    if (!product) continue; // sold out of the catalog: unavailable
    const match = resolveProductPromotion(
      product,
      promotions.data,
      settings.data,
      nearExpiry.data,
      undefined,
      item.weightGrams ?? undefined
    );
    const price =
      match?.discountedUnitPrice ??
      (item.weightGrams != null ? calcWeightedLineTotal(product.basePrice, item.weightGrams) : product.basePrice);
    values.set(item.tempId, {
      priceCents: toCents(price),
      promotionId: match?.promotionId ?? null,
      stock: stockByProduct.get(product.id) ?? null,
    });
  }
  return { conflicts: findBasketConflicts(items, values), loading: false };
}
