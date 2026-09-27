/**
 * promotion-pricing.ts
 *
 * Pure best-price-wins pricing function (PROMO-04, D-05/D-06). Zero imports
 * beyond the Promotion type — independently testable, and mirrored (not
 * literally shared, RESEARCH.md Pitfall 1) in process_direct_sale_atomic's
 * plpgsql body (supabase/migrations/20260904000001_promotion_targets_recurrence.sql),
 * which is the sole authoritative computation at checkout.
 *
 * Phase 28 (D-01..D-06): scope matching moved from the singular
 * scopeType/productId/categoryId columns to promo.targets (0 targets =
 * store-wide); an additional recurrence AND-filter (daysOfWeek/startTime/
 * endTime) is evaluated in the store's configured timezone, never the
 * runtime's own local zone.
 */
import type { Promotion } from '@shared/lib/domain';

export interface PromotionPricingProduct {
  productId: string;
  categoryId: string;
  basePrice: number;
}

/**
 * Converts `now` to the store-local calendar day-of-week (Postgres
 * EXTRACT(DOW) convention: 0=Sunday..6=Saturday) and wall-clock "HH:MM",
 * via `Intl.DateTimeFormat` with an explicit `timeZone` — never
 * `Date.getDay()`/`Date.getHours()`, which read the RUNTIME's own local
 * zone (the cashier's Tauri app, a CI runner, etc.), not the store's
 * configured `settings.general.timezone`. Mirrors
 * `process_direct_sale_atomic`'s `EXTRACT(DOW FROM now() AT TIME ZONE
 * v_store_tz)` / `(now() AT TIME ZONE v_store_tz)::time` exactly.
 */
export function getStoreLocalDowAndTime(
  now: Date,
  timeZone: string
): { dayOfWeek: number; hhmm: string } {
  // 'en-US' here pins Intl's weekday-token vocabulary ('Sun'..'Sat') for the
  // DOW_MAP lookup below, not UI copy — the caller's own locale never
  // affects this.
  // eslint-disable-next-line i18next/no-literal-string
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  const DOW_MAP: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = DOW_MAP[get('weekday')] ?? 0;
  const hhmm = `${get('hour')}:${get('minute')}`;
  return { dayOfWeek, hhmm };
}

export interface PromotionMatch {
  /** The winning promotion's id, or null when the expiry-proximity trigger won. */
  promotionId: string | null;
  /** The winning candidate's discount_value (promotion) or expiryDiscountPercent (expiry trigger). */
  discountRate: number;
  discountAmount: number;
  discountedUnitPrice: number;
}

/** Rounds like Postgres's ROUND(...,2) — ties away from zero for positive inputs. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Everything a promotion candidate must pass BEFORE scope/target matching:
 * active flag, the [startsAt, endsAt] date range (inclusive), and the
 * daysOfWeek/startTime-endTime recurrence AND-filter evaluated in the
 * store's configured timezone (D-03..D-06). Shared by `evaluateBestPromotion`
 * (discount-kind candidates) and `evaluateCombos` (combo-kind candidates,
 * combo-pricing.ts) so the two never drift.
 */
export function isPromotionLiveAt(promo: Promotion, now: Date, timezone: string): boolean {
  if (!promo.active) return false;
  if (now < promo.startsAt || now > promo.endsAt) return false;

  const needsRecurrenceCheck =
    (promo.daysOfWeek !== null && promo.daysOfWeek.length > 0) ||
    (promo.startTime !== null && promo.endTime !== null);
  if (needsRecurrenceCheck) {
    const { dayOfWeek, hhmm } = getStoreLocalDowAndTime(now, timezone);
    if (promo.daysOfWeek !== null && promo.daysOfWeek.length > 0) {
      if (!promo.daysOfWeek.includes(dayOfWeek)) return false;
    }
    if (promo.startTime !== null && promo.endTime !== null) {
      // Normalize to "HH:MM" — startTime/endTime may come back "HH:MM:SS"
      // from the DB's `time` column; a straight string compare against
      // "HH:MM" would otherwise treat an exact-boundary match as less-than
      // (a shorter string that's a prefix of a longer one compares as
      // smaller), breaking the inclusive boundary (D-05).
      const start = promo.startTime.slice(0, 5);
      const end = promo.endTime.slice(0, 5);
      if (hhmm < start || hhmm > end) return false;
    }
  }

  return true;
}

/**
 * Evaluates the best-price-wins candidate pool for one line item: every
 * active promotion matching the product via its `targets` (zero targets =
 * store-wide, D-01) AND passing the recurrence AND-filter (D-03..D-06),
 * plus the expiry-proximity auto-discount trigger — all in one pool
 * (PROMO-04/D-05). The single largest discount amount wins; on an exact tie
 * the most recently created promotion wins (D-06), and the expiry-trigger
 * candidate (no createdAt) loses exact ties against any real promotion.
 *
 * Returns null when no candidate qualifies (no matching promotion, no
 * expiry trigger).
 */
export function evaluateBestPromotion(
  product: PromotionPricingProduct,
  activePromotions: Promotion[],
  now: Date,
  expiryDiscountPercent: number,
  daysUntilExpiry: number | null,
  expiryThresholdDays: number,
  timezone: string
): PromotionMatch | null {
  let bestPromoId: string | null = null;
  let bestPromoRate: number | null = null;
  let bestPromoAmount = -Infinity;
  let bestPromoCreatedAt: number | null = null;

  for (const promo of activePromotions) {
    if (promo.kind === 'combo') continue;
    if (!isPromotionLiveAt(promo, now, timezone)) continue;

    // D-01: zero targets = store-wide, matches any product. Otherwise match
    // if ANY target row references this product or its category.
    const matchesScope =
      promo.targets.length === 0 ||
      promo.targets.some(
        t => t.productId === product.productId || t.categoryId === product.categoryId
      );
    if (!matchesScope) continue;

    const rawAmount =
      promo.discountType === 'percent'
        ? round2((product.basePrice * promo.discountValue) / 100)
        : round2(Math.min(promo.discountValue, product.basePrice));
    const amount = Math.min(rawAmount, product.basePrice);
    const createdAt = promo.createdAt.getTime();

    if (
      amount > bestPromoAmount ||
      (amount === bestPromoAmount && bestPromoCreatedAt !== null && createdAt > bestPromoCreatedAt)
    ) {
      bestPromoAmount = amount;
      bestPromoId = promo.id;
      bestPromoRate = promo.discountValue;
      bestPromoCreatedAt = createdAt;
    }
  }

  const hasPromoCandidate = bestPromoId !== null;

  let expiryAmount: number | null = null;
  if (daysUntilExpiry !== null && daysUntilExpiry <= expiryThresholdDays) {
    expiryAmount = Math.min(
      round2((product.basePrice * expiryDiscountPercent) / 100),
      product.basePrice
    );
  }

  // A real promotion wins exact ties against the expiry candidate (D-06 —
  // the expiry trigger has no createdAt to compare).
  if (hasPromoCandidate && (expiryAmount === null || bestPromoAmount >= expiryAmount)) {
    return {
      promotionId: bestPromoId,
      discountRate: bestPromoRate as number,
      discountAmount: bestPromoAmount,
      discountedUnitPrice: round2(product.basePrice - bestPromoAmount),
    };
  }

  if (expiryAmount !== null) {
    return {
      promotionId: null,
      discountRate: expiryDiscountPercent,
      discountAmount: expiryAmount,
      discountedUnitPrice: round2(product.basePrice - expiryAmount),
    };
  }

  return null;
}
