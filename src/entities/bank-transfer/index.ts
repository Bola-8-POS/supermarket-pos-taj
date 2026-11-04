/**
 * Bank-transfer entity public API.
 *
 * Import from here: `import { usePendingTransfers } from '@entities/bank-transfer'`
 *
 * FSD boundary: features and widgets may import from this index only.
 * Deep imports into model/ are NOT allowed from outside this entity.
 */
export { bankTransferKeys, usePendingTransfers, useAllTransfers } from './model/queries';
export type {
  BankTransfer,
  BankTransferStatus,
  ConfirmTransferInput,
  DisputeTransferInput,
} from './model/types';
export {
  BankTransferSchema,
  ConfirmTransferInputSchema,
  DisputeTransferInputSchema,
} from './model/types';
