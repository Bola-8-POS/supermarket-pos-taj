/**
 * DOMAIN HELPERS
 *
 * Pure functions that compute derived values from domain entities.
 * No side effects. No async. No Supabase calls. Fully testable.
 */

import type { CartItem, Order, DiscountScope, DiscountType } from './domain';

/**
 * Calculates the line total for a cart item.
 *
 * Formula: (unitPrice + modifierPriceDelta) * quantity
 *
 * @param item - The cart item
 * @returns Line total rounded to 2 decimal places
 *
 * @example
 * calculateOrderItemLineTotal({
 *   unitPrice: 5.00,
 *   selectedModifiers: [{ priceDelta: 2.00 }],
 *   quantity: 2
 * })
 * // Returns: 14.00 (7.00 * 2)
 */
export function calculateOrderItemLineTotal(item: CartItem): number {
  const modifierPriceDelta = item.selectedModifiers.reduce(
    (sum, modifier) => sum + modifier.priceDelta,
    0
  );

  const lineTotal = (item.unitPrice + modifierPriceDelta) * item.quantity;

  // Round to 2 decimal places
  return Math.round(lineTotal * 100) / 100;
}

/**
 * Calculates the subtotal for a tab.
 *
 * Sum of all order item line totals.
 *
 * @param orders - Array of orders on the tab
 * @returns Subtotal rounded to 2 decimal places
 *
 * @example
 * calculateTabSubtotal([{ items: [{ lineTotal: 10.00 }, { lineTotal: 5.50 }] }])
 * // Returns: 15.50
 */
export function calculateTabSubtotal(orders: Order[]): number {
  // Sum all order item line totals
  const ordersTotal = orders.reduce((sum, order) => {
    const orderTotal = order.items.reduce((itemSum, item) => {
      return itemSum + (item.lineTotal ?? 0);
    }, 0);
    return sum + orderTotal;
  }, 0);

  // Round to 2 decimal places
  return Math.round(ordersTotal * 100) / 100;
}

/**
 * Formats elapsed time in seconds to a readable string.
 *
 * @param totalSeconds - Total elapsed seconds
 * @returns Formatted string "mm:ss" or "h:mm:ss"
 *
 * @example
 * formatElapsed(90)
 * // Returns: "01:30"
 *
 * @example
 * formatElapsed(3661)
 * // Returns: "1:01:01"
 *
 * @example
 * formatElapsed(45)
 * // Returns: "00:45"
 */
export function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    // Format as h:mm:ss
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return `${String(hours)}:${mm}:${ss}`;
  }

  // Format as mm:ss
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Generates an idempotency key for Square payment calls.
 *
 * Format: `${prefix}_${timestamp}_${randomId}`
 *
 * Used to prevent double-charging if a payment request is retried.
 *
 * @param prefix - Prefix for the key (e.g., "payment", "refund")
 * @returns Idempotency key
 *
 * @example
 * generateIdempotencyKey('payment')
 * // Returns: "payment_1704110400000_a1b2c3d4"
 */
export function generateIdempotencyKey(prefix: string): string {
  const timestamp = Date.now();
  const randomId = crypto.randomUUID().slice(0, 8);
  return `${prefix}_${String(timestamp)}_${randomId}`;
}

/** Minutes a tab has been open (floored), for duration rules and tests. */
function getTabOpenMinutes(openedAt: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - openedAt.getTime()) / 60000);
}

/** Green under 2h, yellow from 2h, red from 4h (per POS tab UX spec). */
export type TabDurationTier = 'ok' | 'warn' | 'critical';

export function getTabDurationTier(openedAt: Date, now: Date = new Date()): TabDurationTier {
  const m = getTabOpenMinutes(openedAt, now);
  if (m >= 240) return 'critical';
  if (m >= 120) return 'warn';
  return 'ok';
}

export function formatTimeOpen(openedAt: Date, now: Date = new Date()): string {
  const minutes = getTabOpenMinutes(openedAt, now);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(remaining)}m`;
}

export function getCurrentTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Returns the portion of the bill that a discount applies to.
 *
 * Phase 27 (PROMO-05): pool_only/consumptions_only scopes were retired —
 * 'all' (itemsSubtotal + poolTotal) is the only remaining scope, kept as a
 * parameter for call-site stability rather than dropped outright.
 */
export function getDiscountBase(
  itemsSubtotal: number,
  poolTotal: number,
  _scope: DiscountScope
): number {
  return Math.round((itemsSubtotal + poolTotal) * 100) / 100;
}

/**
 * Calculates the discount amount from a base, type, and value.
 * Caps the result at the base amount.
 */
export function calculateDiscountAmount(base: number, type: DiscountType, value: number): number {
  if (value <= 0 || base <= 0) return 0;
  const raw = type === 'percent' ? (value / 100) * base : Math.min(value, base);
  return Math.round(Math.min(raw, base) * 100) / 100;
}

