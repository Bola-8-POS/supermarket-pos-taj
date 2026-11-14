/**
 * useConfirmTransfer — TanStack mutation hook for calling the
 * confirm_transfer_payment RPC.
 *
 * Maps AUTH_FORBIDDEN, VALIDATION_ERROR, and PAYMENT_ALREADY_PROCESSED error
 * codes to typed AppError results, mirroring useProcessRefund.ts exactly.
 * Validates the payload client-side via ConfirmTransferInputSchema (defense-
 * in-depth) before calling the RPC; the RPC's own Luhn/equality checks remain
 * the sole authority — this hook never trusts a client-side pass as proof of
 * a correct code (D-08).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  bankTransferKeys,
  ConfirmTransferInputSchema,
  type ConfirmTransferInput,
} from '@entities/bank-transfer';
import i18n from '@shared/lib/i18n';
import type { AppErrorCode, Result } from '@shared/lib/result';
import { err, ok, supabaseMutation } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

export type { ConfirmTransferInput };

export function useConfirmTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfirmTransferInput): Promise<Result<boolean>> => {
      const parsed = ConfirmTransferInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR' as AppErrorCode,
          message: i18n.t('featOrders:confirmDisputeTransfer.codeInvalid'),
        });
      }
      const rpcRes = await supabaseMutation(() =>
        supabase.rpc('confirm_transfer_payment', {
          p_payment_id: parsed.data.paymentId,
          p_entered_code: parsed.data.enteredCode,
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
            message: i18n.t('featOrders:confirmDisputeTransfer.codeInvalid'),
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
