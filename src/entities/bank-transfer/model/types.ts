// src/entities/bank-transfer/model/types.ts
// Re-export all bank-transfer types from the single source of truth in domain.ts.
// Never define types here — infer from Zod schemas.
export type {
  BankTransfer,
  BankTransferStatus,
  ConfirmTransferInput,
  DisputeTransferInput,
} from '@shared/lib/domain';
export {
  BankTransferSchema,
  ConfirmTransferInputSchema,
  DisputeTransferInputSchema,
} from '@shared/lib/domain';
