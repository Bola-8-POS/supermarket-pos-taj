import type { PaymentMethod } from '@shared/lib/domain';
import type { InstanceRole } from '@shared/lib/instance-lock';
import type { LicenseEvaluation } from '@shared/lib/license/types';
import type { checkOfflineSaleLimits } from './limits';

export type OfflineIneligibleReason =
  | 'method'
  | 'split_method'
  | 'card_reference_missing'
  | 'discount'
  | 'override'
  | 'license'
  | 'revalidation'
  | 'no_open_caja'
  | 'limit'
  | 'rering'
  | 'secondary_instance';

export interface OfflineEligibilityInput {
  method: PaymentMethod | undefined;
  legs: readonly { method: PaymentMethod; referenceNumber?: string | null | undefined }[] | undefined;
  referenceNumber: string | null | undefined;
  /** Any discountInfo (scope/type/value/amount) on the sale. */
  hasDiscount: boolean;
  /** managerOverride, approvalId or a below-cost override. */
  hasOverride: boolean;
  licenseState: LicenseEvaluation['state'];
  requiresRevalidation: boolean;
  isCajaOpen: boolean;
  limit: ReturnType<typeof checkOfflineSaleLimits>;
  /** The cart is a manager's re-sale of a refused offline sale: online only, a second offline copy is the double sale. */
  isReRing?: boolean;
  /**
   * Which running copy of the app this is. Only the primary one stores offline sales (a second copy
   * would erase the other's records); `unknown` is the first tick, before the lock settles. Omitted
   * = primary, for callers that do not run in an app window.
   */
  instanceRole?: InstanceRole;
}

const hasText = (v: string | null | undefined): boolean => (v ?? '').trim().length > 0;
const isOfflineMethod = (m: PaymentMethod): boolean => m === 'cash' || m === 'card';

/**
 * Can this sale be rung offline? (Rulings 2, 3, 13, 15, 16.) Pure: the caller
 * reads the stores and passes the facts.
 */
export function evaluateOfflineEligibility(
  input: OfflineEligibilityInput
): { ok: true } | { ok: false; reason: OfflineIneligibleReason } {
  const no = (reason: OfflineIneligibleReason) => ({ ok: false, reason }) as const;

  if (input.instanceRole === 'secondary' || input.instanceRole === 'unknown') {
    return no('secondary_instance');
  }
  if (input.isReRing === true) return no('rering');
  if (input.licenseState === 'restricted' || input.licenseState === 'locked') return no('license');
  if (input.requiresRevalidation) return no('revalidation');
  if (!input.isCajaOpen) return no('no_open_caja');
  if (!input.limit.ok) return no('limit');

  if (input.legs) {
    if (!input.legs.every(l => isOfflineMethod(l.method))) return no('split_method');
    if (input.legs.some(l => l.method === 'card' && !hasText(l.referenceNumber))) {
      return no('card_reference_missing');
    }
  } else if (input.method === undefined || !isOfflineMethod(input.method)) {
    return no('method');
  } else if (input.method === 'card' && !hasText(input.referenceNumber)) {
    return no('card_reference_missing');
  }

  if (input.hasDiscount) return no('discount');
  if (input.hasOverride) return no('override');
  return { ok: true };
}
