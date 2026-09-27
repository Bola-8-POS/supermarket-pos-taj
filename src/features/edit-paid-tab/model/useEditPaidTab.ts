/**
 * useEditPaidTab — TanStack mutation hook for calling the edit_paid_tab RPC.
 *
 * Uses supabaseMutation() (not a raw supabase.rpc() call) so P0V01/P0V02
 * SQLSTATEs are auto-mapped to STALE_VERSION/NOT_FOUND_VERSIONED AppErrors by
 * parseSupabaseError — the same convention useMutationUpdateTabStatus/
 * useMutationCloseCaja already rely on for handleVersionError() to work.
 * NO_OPEN_CAJA (P0A02) and AUTH_FORBIDDEN (P0A01) are custom SQLSTATEs
 * parseSupabaseError doesn't know about, so NO_OPEN_CAJA is still detected
 * via error.message; a refused approval is now returned in the response
 * body as `{ ok: false, code: 'AUTH_FORBIDDEN' | 'PIN_LOCKED' }` instead of
 * being raised, with the message-based AUTH_FORBIDDEN branch kept only for
 * older databases that still raise it. TAB_NOT_EDITABLE is returned by the
 * RPC as a normal `{ ok: false }` payload (not a raised exception), so it's
 * checked on the response body, not on the error.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { auditKeys } from '@entities/audit-log';
import { tabKeys } from '@entities/tab';
import i18n from '@shared/lib/i18n';
import type { AppErrorCode, Result } from '@shared/lib/result';
import { err, ok, supabaseMutation } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Json } from '@shared/lib/supabase.types';

type EditPaidTabPatchOp = 'update' | 'add' | 'delete';

/**
 * Wire shape sent to the RPC — keys match the whitelist read by
 * edit_paid_tab's jsonb patch loop (unit_price/product_id, NOT camelCase).
 */
export interface EditPaidTabPatch {
  op: EditPaidTabPatchOp;
  id?: string;
  quantity?: number;
  unit_price?: number;
  notes?: string;
  product_id?: string;
}

export interface EditPaidTabInput {
  tabId: string;
  expectedVersion: number;
  orderItemPatches: EditPaidTabPatch[];
  notes: string | undefined;
  reason: string;
  approvalId: string;
  /** Id of the staff member the manager prompt matched; the RPC checks it together with the ticket. */
  approverId: string;
}

export interface EditPaidTabRpcResult {
  ok: boolean;
  code?: string;
  message?: string;
  newTotal?: number;
  delta?: number;
  cajaAdjustmentRecorded?: boolean;
  retryAfter?: number;
}

export function useEditPaidTab() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EditPaidTabInput): Promise<Result<EditPaidTabRpcResult>> => {
      const rpcRes = await supabaseMutation(() =>
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
           supabase.types.ts lags behind the schema for p_approver_id (repo-wide cast pattern). */
        (supabase as any).rpc('edit_paid_tab', {
          p_tab_id: input.tabId,
          p_expected_version: input.expectedVersion,
          p_order_item_patches: input.orderItemPatches as unknown as Json,
          p_notes: input.notes ?? '',
          p_reason: input.reason,
          p_approval_id: input.approvalId,
          p_approver_id: input.approverId,
        })
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
      );

      if (!rpcRes.ok) {
        if (rpcRes.error.message.includes('NO_OPEN_CAJA')) {
          return err({
            code: 'CAJA_CLOSED' as AppErrorCode,
            message: i18n.t('featOrders:editPaidTab.noOpenCaja'),
          });
        }
        if (rpcRes.error.message.includes('AUTH_FORBIDDEN')) {
          return err({
            code: 'AUTH_FORBIDDEN' as AppErrorCode,
            message: i18n.t('featOrders:editPaidTab.authForbidden'),
          });
        }
        // STALE_VERSION / NOT_FOUND_VERSIONED already carry the right code via
        // parseSupabaseError (P0V01/P0V02) — surfaced as-is for the
        // component's handleVersionError(), not re-mapped here. Any other
        // unmapped exception (SUPABASE_ERROR default branch) gets a
        // translated message instead of the raw Postgres text.
        return rpcRes.error.code === 'SUPABASE_ERROR'
          ? err({
              code: 'SUPABASE_ERROR' as AppErrorCode,
              message: i18n.t('featOrders:editPaidTab.genericError'),
            })
          : err(rpcRes.error);
      }

      const result = rpcRes.data as EditPaidTabRpcResult | null;
      if (!result || !result.ok) {
        if (result?.code === 'AUTH_FORBIDDEN') {
          return err({ code: 'AUTH_FORBIDDEN' as AppErrorCode, message: i18n.t('featOrders:editPaidTab.authForbidden') });
        }
        if (result?.code === 'PIN_LOCKED') {
          return err({
            code: 'AUTH_FORBIDDEN' as AppErrorCode,
            message: i18n.t('featOrders:managerPinGate.lockedOut', { seconds: result.retryAfter ?? 0 }),
          });
        }
        if (result?.code === 'TAB_NOT_EDITABLE') {
          return err({
            code: 'VALIDATION_ERROR' as AppErrorCode,
            message: i18n.t('featOrders:editPaidTab.notEditable'),
          });
        }
        return err({
          code: 'SUPABASE_ERROR' as AppErrorCode,
          message: i18n.t('featOrders:editPaidTab.genericError'),
        });
      }

      void qc.invalidateQueries({ queryKey: tabKeys.lists() });
      void qc.invalidateQueries({ queryKey: auditKeys.all });
      return ok(result);
    },
  });
}
