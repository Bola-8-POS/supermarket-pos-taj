import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  resolveProductPromotion,
  type Promotion,
  type PromotionPricingSettings,
} from '@entities/promotion';
import { useCartStore } from '@entities/tab/model/cartStore';
import {
  isFreshSincePageLoad,
  planRehydrateCorrections,
  type FetchState,
} from '@entities/tab/model/rehydrateReconcile';
import { formatMoney } from '@shared/lib/format';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';

interface Source<T> {
  data: T | undefined;
  dataUpdatedAt?: number | undefined;
  isFetching?: boolean | undefined;
}

const toState = (s: Source<unknown>): FetchState => ({
  hasData: s.data !== undefined,
  dataUpdatedAt: s.dataUpdatedAt ?? 0,
  isFetching: s.isFetching ?? false,
});

/**
 * Persisted-cart reconciliation: once promotions and near-expiry dates are freshly fetched this
 * page load, every line already in the cart (restored from storage or added before the data
 * loaded) is re-priced to the current
 * best resolved price. Offline / not fresh: cart is restored unchanged (server validates at pay).
 * Runs once per mount; lines flagged `priceConflict` and lines added after that run are never touched.
 */
export function useRehydrateReconcile(args: {
  isOnline: boolean;
  promotions: Source<Promotion[]>;
  nearExpiry: Source<readonly { productId: string; expiryDate: string }[]>;
  settings: PromotionPricingSettings | undefined;
}): void {
  const { isOnline, promotions, nearExpiry, settings } = args;
  const done = useRef(false);
  const fresh = isFreshSincePageLoad(isOnline, toState(promotions), toState(nearExpiry));
  const promoData = promotions.data;
  const expiryData = nearExpiry.data;
  useEffect(() => {
    if (done.current || !fresh || !promoData || !settings) return;
    done.current = true;
    const { items, resolveConflict } = useCartStore.getState();
    // Every line present now was priced before fresh data existed (restored from storage, or added
    // while the dates were still loading), full-price ones included: the server applies the tier or
    // promotion to them too and refuses the sale on any difference (AMOUNT_MISMATCH).
    const corrections = planRehydrateCorrections(items, new Set(items.map(i => i.tempId)), item =>
      resolveProductPromotion(item.product, promoData, settings, expiryData, undefined, item.weightGrams ?? undefined)
    );
    for (const c of corrections) resolveConflict(c.tempId, c.price, c.promotionId);
    const first = corrections[0];
    if (!first) return;
    logger.warn('cart.rehydrate.repriced', { count: corrections.length });
    // PROMO-08: one toast per run, never a silent re-price. Warning variant if any price went up.
    const more = corrections.length - 1;
    const text = i18n.t(more > 0 ? 'common:cartReprice.repricedMore' : 'common:cartReprice.repriced', {
      items: `${first.productName} ${formatMoney(first.oldPrice)} -> ${formatMoney(first.price)}`,
      count: more,
    });
    (corrections.some(c => c.price > c.oldPrice) ? toast.warning : toast.info)(text);
  }, [fresh, promoData, expiryData, settings]);
}
