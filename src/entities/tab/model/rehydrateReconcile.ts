import { weightedLinePrice } from '@entities/promotion';
import type { CartItem } from '@shared/lib/domain';
import { PAGE_LOADED_AT } from '@shared/lib/page-loaded-at';

/** The slice of a resolved promotion match the reconcile compares (see resolveProductPromotion). */
export interface ResolvedPrice {
  promotionId: string | null;
  discountedUnitPrice: number;
}

export interface FetchState {
  /** A usable (ok) result is present. */
  hasData: boolean;
  dataUpdatedAt: number;
  isFetching: boolean;
}

/**
 * Reconcile only on data fetched from the network since this PAGE LOADED (not since the hook
 * mounted: app-level warmers fetch before CheckoutPanel mounts): online, nothing in flight, and
 * `dataUpdatedAt` at/after page load (a persisted-cache restore carries the original, older
 * stamp; an error result has no data).
 */
export function isFreshSincePageLoad(isOnline: boolean, ...states: readonly FetchState[]): boolean {
  return (
    isOnline && states.every(s => s.hasData && !s.isFetching && s.dataUpdatedAt >= PAGE_LOADED_AT)
  );
}

/** Lines that were restored carrying a discount (a promotion, or a near-expiry price below base). */
export function rehydratedDiscountedIds(items: readonly CartItem[]): Set<string> {
  return new Set(
    items
      .filter(i => i.promotionId != null || i.unitPrice !== i.product.basePrice)
      .map(i => i.tempId)
  );
}

export interface PriceCorrection {
  tempId: string;
  /** Per-unit price, or the line total for a weighted line (resolveConflict's contract). */
  price: number;
  promotionId: string | null;
  /** For the cashier notice: product name and the price before (same unit as `price`). */
  productName: string;
  oldPrice: number;
}

/**
 * Corrections for restored lines whose price/promotion differ from the CURRENT best resolved one.
 * Lines flagged `priceConflict` (cashier review, PROMO-08) are never touched.
 */
export function planRehydrateCorrections(
  items: readonly CartItem[],
  restoredIds: ReadonlySet<string>,
  resolve: (item: CartItem) => ResolvedPrice | null | undefined
): PriceCorrection[] {
  const out: PriceCorrection[] = [];
  for (const item of items) {
    if (!restoredIds.has(item.tempId) || item.priceConflict) continue;
    const weighted = item.weightGrams != null;
    const match = resolve(item);
    const price =
      match?.discountedUnitPrice ??
      (weighted ? weightedLinePrice(item.product.basePrice, item.weightGrams ?? 0) : item.product.basePrice);
    const promotionId = match?.promotionId ?? null;
    if (promotionId !== (item.promotionId ?? null) || price !== (weighted ? item.lineTotal : item.unitPrice)) {
      out.push({
        tempId: item.tempId,
        price,
        promotionId,
        productName: item.product.name,
        oldPrice: weighted ? item.lineTotal : item.unitPrice,
      });
    }
  }
  return out;
}
