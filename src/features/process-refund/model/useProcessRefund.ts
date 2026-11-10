/**
 * useProcessRefund — TanStack mutation hook for calling the process_refund RPC.
 *
 * Maps REFUND_EXCEEDS_ORIGINAL, ITEM_NOT_IN_ORIGINAL_ORDER, and AUTH_FORBIDDEN
 * error codes to typed AppError results. Validates the payload client-side via
 * ProcessRefundInputSchema (defense-in-depth, SALE-06) before calling the RPC;
 * the RPC's own cross-row/DB-state checks remain the sole authority.
 *
 * The idempotency key is minted once per refund attempt and bound to the
 * target payment (`{ paymentId, key }`), because RefundSheet stays mounted
 * for the whole /payments session — only its `paymentId` prop changes as the
 * cashier opens it against different rows. Without the payment binding, a
 * refund for payment A whose response was lost would leave its key attached
 * to the hook for the rest of the session; a later refund for payment B
 * would replay that same key with a different scope and the server would
 * reject it as IDEMPOTENCY_MISMATCH forever (fix-pass F3). A duplicate submit
 * for the SAME payment still reuses the key and replays. RefundSheet also
 * calls resetIdempotencyKey() when the sheet closes (success or Cancel), and
 * an IDEMPOTENCY_* rejection below discards the key itself so the very next
 * attempt is never doomed to repeat the same mismatch.
 *
 * The refund/tab query invalidation runs unconditionally, before branching
 * on rpcRes.ok (F3 fix round 1): a "generic error" here can still mean the
 * RPC actually committed and only the response was lost. RefundSheet stays
 * mounted with a 5-min staleTime, so without refreshing on every outcome, a
 * reopened sheet after a lost-response error kept showing the refunded item
 * as still fully refundable, letting a manager pay a second partial refund.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import { useCajaStore } from '@entities/caja';
import { ProcessRefundInputSchema, refundKeys, type ProcessRefundInput } from '@entities/refund';
import { tabKeys } from '@entities/tab';
import { generateIdempotencyKey } from '@shared/lib/domain-helpers';
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
  const idempotencyRef = useRef<{ paymentId: string; key: string } | undefined>(undefined);
  const mutation = useMutation({
    mutationFn: async (input: ProcessRefundMutationInput): Promise<Result<string>> => {
      const parsed = ProcessRefundInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR' as AppErrorCode,
          message: i18n.t('featOrders:processRefund.invalidPayload'),
        });
      }
      if (idempotencyRef.current?.paymentId !== input.originalPaymentId) {
        idempotencyRef.current = {
          paymentId: input.originalPaymentId,
          // eslint-disable-next-line i18next/no-literal-string -- idempotency-key prefix, not UI copy
          key: generateIdempotencyKey('refund'),
        };
      }
      const idempotencyKey = idempotencyRef.current.key;
      const rpcRes = await supabaseMutation(() =>
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
           supabase.types.ts lags behind the schema for p_approver_id/p_idempotency_key (repo-wide cast pattern). */
        (supabase as any).rpc('process_refund', {
          p_original_payment_id: parsed.data.originalPaymentId,
          p_items: parsed.data.items,
          p_reason: parsed.data.reason,
          p_approval_id: input.approvalId,
          p_approver_id: input.approverId,
          p_caja_session_id: useCajaStore.getState().currentCaja?.id ?? null,
          p_idempotency_key: idempotencyKey,
        })
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
      );
      // Every outcome below (success, a business-rule rejection, an
      // idempotency rejection, or an unmapped/network error) must refresh
      // what RefundSheet reads: a "generic error" can still mean the RPC
      // actually committed and only the response was lost. RefundSheet stays
      // mounted with a 5-min staleTime and no refetch-on-focus, so without
      // this the reopened sheet keeps showing the item as fully refundable
      // and a second partial refund can be paid for real (F3 fix round 1).
      void qc.invalidateQueries({ queryKey: refundKeys.lists() });
      void qc.invalidateQueries({ queryKey: refundKeys.byPayment(input.originalPaymentId) });
      void qc.invalidateQueries({ queryKey: tabKeys.lists() });
      if (!rpcRes.ok) {
        if (/^IDEMPOTENCY_/.test(rpcRes.error.message)) {
          // The ledger rejected a replay whose scope hash (or caller/key
          // shape) no longer matches — the key is poisoned, so discard it
          // now rather than let every subsequent attempt for this payment
          // keep resending it and keep failing the same way (fix-pass F3).
          idempotencyRef.current = undefined;
          return err({
            code: 'VALIDATION_ERROR' as AppErrorCode,
            message: i18n.t('featOrders:processRefund.idempotencyReplay'),
          });
        }
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
      return ok(rpcRes.data as string);
    },
  });
  return {
    ...mutation,
    resetIdempotencyKey: () => {
      idempotencyRef.current = undefined;
    },
  };
}
