import {
  daysUntilExpiryOn,
  evaluateBestPromotion,
  weightedLinePrice,
  type PromotionMatch,
} from './promotion-pricing';
import type { Promotion } from './types';

/** The slice of the settings snapshot that promotion pricing reads. */
export interface PromotionPricingSettings {
  nearExpiry: { discountPercent: number; thresholdDays: number };
  general: { timezone: string };
}

/**
 * The best promotion for a catalog product right now, resolved from the same inputs everywhere
 * the checkout prices a line (scan or tap, reconnect re-check, re-ring): the live promotions,
 * the store settings and the near-expiry alerts. One place so those callers cannot drift apart.
 * `nearExpiryDates` may be undefined while it loads (no expiry discount then).
 *
 * `weightGrams` marks a loose-weight line. The server prices the line first and discounts the
 * LINE (`ROUND(base * grams / 1000, 2)`, a fixed discount taken once, a percent one rounded on the
 * line), so the match is then evaluated on that line price: `discountedUnitPrice` and
 * `discountAmount` are line amounts, not per-kg ones.
 *
 * `nearExpiryDates` is the pricing source (`useNearExpiryPricingDates`): product id + expiry date.
 * The day count is taken from the date at `now` (the server's rule), never from a cached count.
 */
export function resolveProductPromotion(
  product: { id: string; categoryId: string; basePrice: number },
  promotions: Promotion[],
  settings: PromotionPricingSettings,
  nearExpiryDates: readonly { productId: string; expiryDate: string }[] | undefined,
  now: Date = new Date(),
  weightGrams?: number
): PromotionMatch | null {
  const dated = nearExpiryDates?.find(d => d.productId === product.id);
  const daysUntilExpiry = dated ? daysUntilExpiryOn(dated.expiryDate, now, settings.general.timezone) : null;
  return evaluateBestPromotion(
    {
      productId: product.id,
      categoryId: product.categoryId,
      basePrice:
        weightGrams === undefined
          ? product.basePrice
          : weightedLinePrice(product.basePrice, weightGrams),
      weightGrams,
    },
    promotions,
    now,
    settings.nearExpiry.discountPercent,
    daysUntilExpiry,
    settings.nearExpiry.thresholdDays,
    settings.general.timezone
  );
}
