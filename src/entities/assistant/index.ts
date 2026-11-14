export {
  productLookup,
  expiryList,
  lowStock,
  salesSummary,
  productList,
  recentSales,
  LOOKUP_ROW_CAP,
  EXPIRY_ROW_CAP,
  LOW_STOCK_ROW_CAP,
} from './model/reads';
export type { ProductLookupResult, ExpiryListResult, LowStockResult, LowStockTarget, RecentSalesScope } from './model/reads';
export {
  assistantGate,
  stageProposal,
  approveProposal,
  finishProposal,
  cancelProposal,
  recordRejection,
} from './model/rpc';
export { useAssistantProposalText, assistantTextKeys } from './model/proposalText';
export type { StageInput, StageItem, PriceStageItem, ApproveInput } from './model/rpc';
