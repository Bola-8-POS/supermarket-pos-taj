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
import { round2 } from '@shared/lib/round2';
import { canonicalTimeZone } from '@shared/lib/timezone';

export interface PromotionPricingProduct {
  productId: string;
  categoryId: string;
  basePrice: number;
  /** set for a weighed line: basePrice is then the line price and a fixed amount is per kilogram */
  weightGrams: number | undefined;
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
): { dayOfWeek: number; hhmm: string; clock: string } {
  // 'en-US' here pins Intl's weekday-token vocabulary ('Sun'..'Sat') for the
  // DOW_MAP lookup below, not UI copy — the caller's own locale never
  // affects this.
  // eslint-disable-next-line i18next/no-literal-string
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: storeZone(timeZone),
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
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
  // Second- and millisecond-exact wall clock, fixed width so string order is time order.
  const clock = `${hhmm}:${get('second')}.${String(now.getUTCMilliseconds()).padStart(3, '0')}`;
  return { dayOfWeek, hhmm, clock };
}

export interface PromotionMatch {
  /** The winning promotion's id, or null when the expiry-proximity trigger won. */
  promotionId: string | null;
  /** The winning candidate's discount_value (promotion) or expiryDiscountPercent (expiry trigger). */
  discountRate: number;
  discountAmount: number;
  discountedUnitPrice: number;
}

export { round2 };

/**
 * The price of a loose-weight line: SQL's `ROUND(base_price * (grams / 1000.0), 2)`
 * (process_direct_sale_atomic `v_expected_price`), the number its `unit_price` check compares to.
 * Promotions are evaluated on this line price, never on the per-kg price (see
 * `resolveProductPromotion`'s `weightGrams`).
 */
export function weightedLinePrice(pricePerKg: number, weightGrams: number): number {
  return round2((pricePerKg * weightGrams) / 1000);
}

/** The zone process_direct_sale_atomic falls back to when settings.general.timezone is rejected. */
const FALLBACK_TIME_ZONE = 'America/Mexico_City';

/**
 * `timeZone` if it is a supported IANA name (`canonicalTimeZone`: one meaning of "valid" on the
 * till), else the server's fallback zone. The server validates one zone for the near-expiry tier
 * and the promotion windows alike. A stored value outside the list (a POSIX string, an
 * abbreviation) is treated as invalid.
 */
function storeZone(timeZone: string): string {
  return canonicalTimeZone(timeZone) ?? FALLBACK_TIME_ZONE;
}

/** One date formatter per zone: pricing runs per product. */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The store's calendar date ('YYYY-MM-DD') at `now`: SQL `(now() AT TIME ZONE tz)::date`.
 */
export function storeLocalDate(now: Date, timeZone: string): string {
  const zone = storeZone(timeZone);
  let fmt = dateFormatters.get(zone);
  if (!fmt) {
    // eslint-disable-next-line i18next/no-literal-string
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatters.set(zone, fmt);
  }
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Whole days from the store's "today" to an `expiry_date` ('YYYY-MM-DD'), counted the way the
 * server does: process_direct_sale_atomic tests
 * `expiry_date <= (now() AT TIME ZONE store_tz)::date + threshold`, with the same
 * settings.general.timezone the promotion windows use. Counting at pricing time, from the date,
 * keeps a catalog cached before midnight honest.
 */
export function daysUntilExpiryOn(expiryDate: string, now: Date, timeZone: string): number {
  return Math.round(
    (Date.parse(expiryDate) - Date.parse(storeLocalDate(now, timeZone))) / 86_400_000
  );
}

/**
 * Postgres `time` text ("HH:MM", "HH:MM:SS", "HH:MM:SS.ffffff") as the same
 * fixed-width "HH:MM:SS.mmm" that getStoreLocalDowAndTime().clock uses.
 */
function toClock(t: string): string {
  const [hms = '', frac = ''] = t.split('.');
  const [h = '00', m = '00', s = '00'] = hms.split(':');
  return `${h}:${m}:${s}.${frac.padEnd(3, '0').slice(0, 3)}`;
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

  // SQL: days_of_week IS NULL OR DOW = ANY(days_of_week). Null is every day; an
  // empty array is NOT "every day", x = ANY('{}') is false so it never matches.
  const needsRecurrenceCheck =
    promo.daysOfWeek !== null || (promo.startTime !== null && promo.endTime !== null);
  if (needsRecurrenceCheck) {
    const { dayOfWeek, clock } = getStoreLocalDowAndTime(now, timezone);
    if (promo.daysOfWeek !== null && !promo.daysOfWeek.includes(dayOfWeek)) return false;
    if (promo.startTime !== null && promo.endTime !== null) {
      // SQL: (now() AT TIME ZONE tz)::time BETWEEN start_time AND end_time,
      // inclusive and exact to the sub-second, so compare the full clock.
      if (clock < toClock(promo.startTime) || clock > toClock(promo.endTime)) return false;
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
        : round2(
            Math.min(
              // a fixed amount on a weighed line is per kilogram (Ruling 11)
              product.weightGrams === undefined
                ? promo.discountValue
                : round2((promo.discountValue * product.weightGrams) / 1000),
              product.basePrice
            )
          );
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
