export {
  OFFLINE_SALE_APPROVAL_ACTION,
  useResolveOfflineSale,
  type ManagerApprovalTicket,
  type OfflineSaleResolver,
  type ReRingOutcome,
  type ResolveOutcome,
} from './model/useResolveOfflineSale';
export { OfflineSalesDialog, type OfflineSalesDialogProps } from './ui/OfflineSalesDialog';
export { OfflineSalesPanel, type OfflineSalesPanelProps } from './ui/OfflineSalesPanel';
// The pure arithmetic and the completion live in the offline-sale entity (the checkout, a sibling
// feature, must call completion and features may not import features); re-exported for one import site.
export { completeReRing, reRingAdjustment } from '@entities/offline-sale';
