export type { OfflineSale } from '@shared/lib/offline-sale-schema';
export {
  applyOfflineSaleEvent,
  reduceOfflineSale,
  type OfflineSaleEvent,
} from './model/machine';
export { offlineSalesBlock, type OfflineBlockedAction } from './model/blocks';
export { OFFLINE_SALE_LIMITS, checkOfflineSaleLimits } from './model/limits';
export {
  evaluateOfflineEligibility,
  type OfflineEligibilityInput,
  type OfflineIneligibleReason,
} from './model/eligibility';
export { computeSaleIntegrity, verifySaleIntegrity } from './model/integrity';
export { buildProvisionalReceipt, provisionalReceiptNumber } from './model/provisional-receipt';
export {
  selectBlocking,
  selectNeedsReview,
  selectNextForReplay,
  selectPending,
  useOfflineSaleStore,
  type EnqueueOfflineSaleInput,
} from './model/store';
export {
  classifyReplayResult,
  offlineSaleTotal,
  type ReplayEvent,
  type ReplayVerdict,
} from './model/replay-outcome';
export {
  clipAuditText,
  offlineSaleAuditSummary,
  recordOfflineSaleAudit,
  type OfflineSaleAuditAction,
} from './model/audit';
export { completeReRing, reRingAdjustment, unlinkedReRingTab } from './model/rering';
export { sameGoods, type GoodsLine } from './model/goods';
