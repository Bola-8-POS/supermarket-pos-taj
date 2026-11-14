/**
 * useIssueOfflineApprovals — a manager, while online, issues single-use
 * pre-approvals for one action to this terminal (issue_offline_approval_grants),
 * consuming the ticket their PIN just earned. The grants are kept locally so
 * the manager PIN gate can redeem them while the terminal is offline.
 * See docs/superpowers/specs/2026-09-29-offline-approval-scope.md.
 */
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';

import { storeOfflineGrants, type OfflineGrant } from '@entities/staff/model/offlineApproval';
import i18n from '@shared/lib/i18n';
import type { StaffAction } from '@shared/lib/rbac';
import { err, ok, supabaseMutation, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
// The business terminal id (e.g. POS-1), not the licence installation UUID.
import { getTerminalId } from '@shared/lib/terminal';

/**
 * The actions offered for pre-approval: only those with a manager PIN gate
 * marked `offlineCapable`, i.e. whose action still completes offline. Today
 * that is reopen_tab at the add-items save on a reopened sale (the order is
 * queued for replay). The server also accepts process_refund, edit_paid_tab
 * and apply_custom_discount (offline_approval_grants.action); add them here
 * once their mutations can complete or queue offline.
 */
export const GRANTABLE_ACTIONS = ['reopen_tab'] as const satisfies readonly StaffAction[];
export type GrantableAction = (typeof GRANTABLE_ACTIONS)[number];

export interface IssueOfflineApprovalsInput {
  approvalId: string;
  approverId: string;
  action: GrantableAction;
  count: number;
  validMinutes: number;
}

const IssuedGrantsSchema = z.array(
  z.object({
    id: z.string(),
    action: z.string(),
    terminal_id: z.string(),
    granted_by: z.string(),
    requested_for: z.string(),
    expires_at: z.string(),
  })
);

export function useIssueOfflineApprovals() {
  return useMutation({
    mutationFn: async (input: IssueOfflineApprovalsInput): Promise<Result<OfflineGrant[]>> => {
      const res = await supabaseMutation(() =>
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
           issue_offline_approval_grants is not in supabase.types.ts (repo-wide cast pattern). */
        (supabase as any).rpc('issue_offline_approval_grants', {
          p_approval_id: input.approvalId,
          p_approver_id: input.approverId,
          p_action: input.action,
          p_count: input.count,
          p_valid_minutes: input.validMinutes,
          p_terminal_id: getTerminalId(),
        })
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
      );
      const parsed = res.ok ? IssuedGrantsSchema.safeParse(res.data) : null;
      if (!parsed?.success) {
        return err({
          code: res.ok ? 'VALIDATION_ERROR' : res.error.code,
          message: i18n.t('featOrders:issueOfflineApprovals.failed'),
        });
      }
      const grants: OfflineGrant[] = parsed.data.map(g => ({
        id: g.id,
        action: g.action,
        grantedBy: g.granted_by,
        requestedFor: g.requested_for,
        terminalId: g.terminal_id,
        expiresAt: Date.parse(g.expires_at),
      }));
      storeOfflineGrants(grants);
      return ok(grants);
    },
  });
}
