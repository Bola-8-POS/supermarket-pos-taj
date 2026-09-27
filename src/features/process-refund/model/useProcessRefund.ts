/**
 * useProcessRefund — TanStack mutation hook for calling the process_refund RPC.
 *
 * Maps REFUND_EXCEEDS_ORIGINAL, ITEM_NOT_IN_ORIGINAL_ORDER, and AUTH_FORBIDDEN
 * error codes to typed AppError results. Validates the payload client-side via
 * ProcessRefundInputSchema (defense-in-depth, SALE-06) before calling the RPC;
 * the RPC's own cross-row/DB-state checks remain the sole authority.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useCajaStore } from '@entities/caja';
import { ProcessRefundInputSchema, refundKeys, type ProcessRefundInput } from '@entities/refund';
import { tabKeys } from '@entities/tab';
import i18n from '@shared/lib/i18n';
import type { AppErrorCode, Result } from '@shared/lib/result';
import { err, ok, supabaseMutation } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

export type { ProcessRefundInput };

/**
 * ProcessRefundInput extended with the approval ticket from
 * ManagerPinDialog's onSuccess callback — threaded through to the RPC, which
 * consumes it to derive the authorizing staff
 * (folded todo fix, mirrors G-27-13). Not added to ProcessRefundInputSchema
 * in domain.ts: Zod's default .safeParse strips unknown keys, so this local
 * extension is sufficient and avoids touching a file another plan in this
 * wave also touches.
 */
export interface ProcessRefundMutationInput extends ProcessRefundInput {
  approvalId: string;
  /** Id of the staff member the manager prompt matched; the RPC checks it together with the ticket. */
  approverId: string;
}

export function useProcessRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProcessRefundMutationInput): Promise<Result<string>> => {
      const parsed = ProcessRefundInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR' as AppErrorCode,
          message: i18n.t('featOrders:processRefund.invalidPayload'),
        });
      }
      const rpcRes = await supabaseMutation(() =>
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
           supabase.types.ts lags behind the schema for p_approver_id (repo-wide cast pattern). */
        (supabase as any).rpc('process_refund', {
          p_original_payment_id: parsed.data.originalPaymentId,
          p_items: parsed.data.items,
          p_reason: parsed.data.reason,
          p_approval_id: input.approvalId,
          p_approver_id: input.approverId,
          p_caja_session_id: useCajaStore.getState().currentCaja?.id ?? null,
        })
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
      );
      if (!rpcRes.ok) {
        if (rpcRes.error.message.includes('REFUND_EXCEEDS_ORIGINAL')) {
          return err({ code: 'REFUND_EXCEEDS_ORIGINAL' as AppErrorCode, message: i18n.t('featOrders:processRefund.exceedsOriginal') });
        }
        if (rpcRes.error.message.includes('ITEM_NOT_IN_ORIGINAL_ORDER')) {
          return err({ code: 'ITEM_NOT_IN_ORIGINAL_ORDER' as AppErrorCode, message: i18n.t('featOrders:processRefund.itemNotInOriginalOrder') });
        }
        if (rpcRes.error.message.includes('AUTH_FORBIDDEN')) {
          return err({ code: 'AUTH_FORBIDDEN' as AppErrorCode, message: i18n.t('featOrders:processRefund.authForbidden') });
        }
        if (rpcRes.error.message.includes('CAJA_SESSION_NOT_OPEN')) {
          return err({ code: 'CAJA_SESSION_NOT_OPEN' as AppErrorCode, message: i18n.t('featOrders:processRefund.cajaNotOpen') });
        }
        return err({
          code: rpcRes.error.code,
          message: i18n.t('featOrders:processRefund.genericError'),
          raw: rpcRes.error.raw,
        });
      }
      if (rpcRes.data === null) {
        // The RPC returns NULL (rather than raising) when the approval is
        // refused, so the attempt count still gets recorded server-side.
        return err({
          code: 'AUTH_FORBIDDEN' as AppErrorCode,
          message: i18n.t('featOrders:processRefund.authForbidden'),
        });
      }
      void qc.invalidateQueries({ queryKey: refundKeys.lists() });
      void qc.invalidateQueries({ queryKey: refundKeys.byPayment(input.originalPaymentId) });
      void qc.invalidateQueries({ queryKey: tabKeys.lists() });
      return ok(rpcRes.data as string);
    },
  });
}
