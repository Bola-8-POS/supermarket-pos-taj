import type { OfflineIneligibleReason } from '@entities/offline-sale';
import { OFFLINE_SALE_LIMITS } from '@entities/offline-sale';

/**
 * Why a sale cannot be rung offline. Every eligibility reason the entity can give, plus the two
 * a failed limit is split into by the checkout hook. The record below is keyed on the union, so
 * a reason added to the entity does not compile until it is listed here and given copy.
 */
export type OfflineRefusalReason = OfflineIneligibleReason | 'limit_count' | 'limit_age';

const REASONS: Record<OfflineRefusalReason, true> = {
  method: true,
  split_method: true,
  card_reference_missing: true,
  discount: true,
  override: true,
  license: true,
  revalidation: true,
  no_open_caja: true,
  limit: true,
  limit_count: true,
  limit_age: true,
  rering: true,
  secondary_instance: true,
};

export const OFFLINE_REFUSAL_REASONS = Object.keys(REASONS) as OfflineRefusalReason[];

const isReason = (value: string): value is OfflineRefusalReason => Object.hasOwn(REASONS, value);

/**
 * The offline reason carried by a checkout error, or null. A server refusal also puts a string
 * in `details` ("<EDGE_CODE>: message"), so `details` only means "reason" on NETWORK_OFFLINE.
 */
export function offlineReasonOf(error: {
  code?: string;
  details?: string | undefined;
}): OfflineRefusalReason | null {
  if (error.code !== 'NETWORK_OFFLINE' || error.details === undefined) return null;
  return isReason(error.details) ? error.details : null;
}

export const offlineReasonKey = (reason: OfflineRefusalReason): string =>
  `featOrders:offlineCheckout.reason.${reason}`;

/** Interpolation values every reason message may use (the limits live in one file, owner-tunable). */
export const OFFLINE_REASON_PARAMS = {
  count: OFFLINE_SALE_LIMITS.maxNonTerminal,
  hours: OFFLINE_SALE_LIMITS.maxOldestAgeMs / 3_600_000,
} as const;
