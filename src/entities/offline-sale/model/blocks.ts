import i18n from '@shared/lib/i18n';
import type { AppError } from '@shared/lib/result';
import { selectBlocking, selectPending, useOfflineSaleStore } from './store';

export type OfflineBlockedAction = 'closeCaja' | 'clockOut' | 'signOut';

/**
 * Ruling 13 (relaxed by owner decision D1): close caja is refused while any offline sale is
 * queued, replaying or in review; clock-out and sign-out only while one is queued or replaying
 * (the replay needs that cashier's session/shift - a sale in review is resolved by a manager
 * from any session). `staffId` scopes the check (R28): close caja passes `undefined` (the drawer
 * is shared, so any cashier's pending sale blocks it); clock-out and sign-out pass the staff
 * member concerned, because only the selling cashier can replay a record (Ruling 8), so
 * another cashier's pending sale must not trap them. Returns the typed refusal, or
 * `undefined` when the action may proceed.
 */
export function offlineSalesBlock(
  action: OfflineBlockedAction,
  staffId: string | undefined
): AppError | undefined {
  const select = action === 'closeCaja' ? selectBlocking : selectPending;
  const blocking = select(useOfflineSaleStore.getState()).filter(
    r => staffId === undefined || r.staffId === staffId
  );
  if (blocking.length === 0) return undefined;

  const count = blocking.length;
  const head =
    action === 'closeCaja'
      ? i18n.t('common:offlineSales.blocked.closeCaja', { count })
      : action === 'clockOut'
        ? i18n.t('common:offlineSales.blocked.clockOut', { count })
        : i18n.t('common:offlineSales.blocked.signOut', { count });
  const needsReview = blocking.filter(r => r.status === 'needs_review').length;
  return {
    code: 'OFFLINE_SALES_PENDING',
    message:
      needsReview > 0
        ? `${head} ${i18n.t('common:offlineSales.blocked.needsReview', { count: needsReview })}`
        : head,
  };
}
