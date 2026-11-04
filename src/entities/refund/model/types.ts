// src/entities/refund/model/types.ts
// Re-export all refund types from the single source of truth in domain.ts.
// Never define types here — infer from Zod schemas.
export type {
  Refund,
  RefundItem,
  RefundReason,
  ProcessRefundInput,
} from '@shared/lib/domain';
export { ProcessRefundInputSchema } from '@shared/lib/domain';
