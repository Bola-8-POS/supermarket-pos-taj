/**
 * useDisputeTransfer — TanStack mutation hook for calling the
 * dispute_transfer_payment RPC.
 *
 * Same shape as useConfirmTransfer: maps AUTH_FORBIDDEN, VALIDATION_ERROR,
 * and PAYMENT_ALREADY_PROCESSED error codes to typed AppError results,
 * mirroring useProcessRefund.ts exactly.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  bankTransferKeys,
  DisputeTransferInputSchema,
  type DisputeTransferInput,
} from '@entities/bank-transfer';
import i18n from '@shared/lib/i18n';
import type { AppErrorCode, Result } from '@shared/lib/result';
import { err, ok, supabaseMutation } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

export type { DisputeTransferInput };

export function useDisputeTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DisputeTransferInput): Promise<Result<boolean>> => {
      const parsed = DisputeTransferInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR' as AppErrorCode,
          message: i18n.t('featOrders:confirmDisputeTransfer.reasonRequired'),
        });
      }
      const rpcRes = await supabaseMutation(() =>
        supabase.rpc('dispute_transfer_payment', {
          p_payment_id: parsed.data.paymentId,
          p_reason: parsed.data.reason,
        })
      );
      if (!rpcRes.ok) {
        if (rpcRes.error.message.includes('AUTH_FORBIDDEN')) {
          return err({
            code: 'AUTH_FORBIDDEN' as AppErrorCode,
            message: i18n.t('featOrders:confirmDisputeTransfer.authForbidden'),
          });
        }
        if (rpcRes.error.message.includes('VALIDATION_ERROR')) {
          return err({
            code: 'VALIDATION_ERROR' as AppErrorCode,
            message: i18n.t('featOrders:confirmDisputeTransfer.reasonRequired'),
          });
        }
        if (rpcRes.error.message.includes('PAYMENT_ALREADY_PROCESSED')) {
          return err({
            code: 'PAYMENT_ALREADY_PROCESSED' as AppErrorCode,
            message: i18n.t('featOrders:confirmDisputeTransfer.alreadyProcessed'),
          });
        }
        return err({
          code: rpcRes.error.code,
          message: i18n.t('featOrders:confirmDisputeTransfer.genericError'),
          raw: rpcRes.error.raw,
        });
      }
      void qc.invalidateQueries({ queryKey: bankTransferKeys.lists() });
      return ok(true);
    },
  });
}
