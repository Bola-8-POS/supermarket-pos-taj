/**
 * useReopenTab — TanStack mutation hook for calling the reopen_tab RPC.
 *
 * Uses supabaseMutation() (not a raw supabase.rpc() call) so P0V01/P0V02
 * SQLSTATEs are auto-mapped to STALE_VERSION/NOT_FOUND_VERSIONED AppErrors by
 * parseSupabaseError — same convention as useEditPaidTab, so the dialog's
 * handleVersionError() works unmodified. NO_OPEN_CAJA (P0A02) and
 * AUTH_FORBIDDEN (P0A01) are custom SQLSTATEs parseSupabaseError doesn't know
 * about, so NO_OPEN_CAJA is still detected via error.message; a refused
 * approval is now returned in the response body as `{ ok: false, code:
 * 'AUTH_FORBIDDEN' | 'PIN_LOCKED' }` instead of being raised, with the
 * message-based AUTH_FORBIDDEN branch kept only for older databases that
 * still raise it.
 * REOPEN_CAP_EXCEEDED / REOPEN_WINDOW_EXPIRED / TAB_NOT_REOPENABLE are
 * returned by the RPC as a normal `{ ok: false }` payload (not raised
 * exceptions), so they're checked on the response body, not on the error —
 * same pattern as edit_paid_tab's TAB_NOT_EDITABLE.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { auditKeys } from '@entities/audit-log';
import { paymentKeys } from '@entities/payment';
import { tabKeys } from '@entities/tab';
import i18n from '@shared/lib/i18n';
import type { AppErrorCode, Result } from '@shared/lib/result';
import { err, ok, supabaseMutation } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

export interface ReopenTabInput {
  tabId: string;
  expectedVersion: number;
  reason: string;
  approvalId: string;
  /** Id of the staff member the manager prompt matched; the RPC checks it together with the ticket. */
  approverId: string;
}

export interface ReopenTabRpcResult {
  ok: boolean;
  code?: string;
  message?: string;
  voidedPaymentTotal?: number;
  retryAfter?: number;
}

export function useReopenTab() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReopenTabInput): Promise<Result<ReopenTabRpcResult>> => {
      const rpcRes = await supabaseMutation(() =>
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
           supabase.types.ts lags behind the schema for p_approver_id (repo-wide cast pattern). */
        (supabase as any).rpc('reopen_tab', {
          p_tab_id: input.tabId,
          p_expected_version: input.expectedVersion,
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
            message: i18n.t('featOrders:reopenTab.noOpenCaja'),
          });
        }
        if (rpcRes.error.message.includes('AUTH_FORBIDDEN')) {
          return err({
            code: 'AUTH_FORBIDDEN' as AppErrorCode,
            message: i18n.t('featOrders:reopenTab.authForbidden'),
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
              message: i18n.t('featOrders:reopenTab.genericError'),
            })
          : err(rpcRes.error);
      }

      const result = rpcRes.data as ReopenTabRpcResult | null;
      if (!result || !result.ok) {
        if (result?.code === 'AUTH_FORBIDDEN') {
          return err({ code: 'AUTH_FORBIDDEN' as AppErrorCode, message: i18n.t('featOrders:reopenTab.authForbidden') });
        }
        if (result?.code === 'PIN_LOCKED') {
          return err({
            code: 'AUTH_FORBIDDEN' as AppErrorCode,
            message: i18n.t('featOrders:managerPinGate.lockedOut', { seconds: result.retryAfter ?? 0 }),
          });
        }
        if (result?.code === 'REOPEN_CAP_EXCEEDED') {
          return err({
            code: 'VALIDATION_ERROR' as AppErrorCode,
            message: i18n.t('featOrders:reopenTab.capExceeded'),
          });
        }
        if (result?.code === 'REOPEN_WINDOW_EXPIRED') {
          return err({
            code: 'VALIDATION_ERROR' as AppErrorCode,
            message: i18n.t('featOrders:reopenTab.windowExpired'),
          });
        }
        if (result?.code === 'TAB_NOT_REOPENABLE') {
          return err({
            code: 'VALIDATION_ERROR' as AppErrorCode,
            message: i18n.t('featOrders:reopenTab.notReopenable'),
          });
        }
        return err({
          code: 'SUPABASE_ERROR' as AppErrorCode,
          message: i18n.t('featOrders:reopenTab.genericError'),
        });
      }

      void qc.invalidateQueries({ queryKey: tabKeys.lists() });
      // Plan 09-01 (Rule 1 fix): also invalidate this specific tab's detail
      // query — PaymentPane's per-row EditItemsButton (09-01) reads
      // useTab(payment.tabId) to decide visibility, and that query was
      // already mounted (and cached at status='paid') before this reopen,
      // so invalidating only tabKeys.lists() left it permanently stale.
      void qc.invalidateQueries({ queryKey: tabKeys.detail(input.tabId) });
      void qc.invalidateQueries({ queryKey: paymentKeys.lists() });
      void qc.invalidateQueries({ queryKey: auditKeys.all });
      return ok(result);
    },
  });
}
