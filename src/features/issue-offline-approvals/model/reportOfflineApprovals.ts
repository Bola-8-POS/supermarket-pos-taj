/**
 * Reports the pre-approvals this terminal redeemed while offline
 * (report_offline_approvals), so each one lands in the audit log with the
 * issuing manager, the staff member who used it, the terminal and the local
 * time of use. A failed report keeps the uses for the next attempt. The server
 * only accepts a use from the cashier who made it, so each session reports just
 * its own uses and leaves the rest queued for their owner's next online session.
 */
import { useEffect } from 'react';

import { markGrantUsesReported, pendingGrantUses } from '@entities/staff/model/offlineApproval';
import { useStaffStore } from '@entities/staff/model/store';
import { useOnlineStatus } from '@shared/lib/connectivity';
import { supabaseMutation } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

/** The RPC accepts at most 100 uses per call; any remainder goes on the next trigger. */
const BATCH = 100;

export async function reportOfflineApprovals(): Promise<void> {
  const me = useStaffStore.getState().currentStaff?.id;
  if (!me) return;
  const batch = pendingGrantUses().filter(u => u.usedBy === me).slice(0, BATCH);
  if (batch.length === 0) return;
  const res = await supabaseMutation(() =>
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
       report_offline_approvals is not in supabase.types.ts (repo-wide cast pattern). */
    (supabase as any).rpc('report_offline_approvals', { p_uses: batch })
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
  );
  if (res.ok) markGrantUsesReported(batch.map(u => u.grantId));
}

/** Mounted once in the app shell: reports whenever the terminal is online and signed in. */
export function OfflineApprovalReporter(): null {
  const online = useOnlineStatus();
  const signedIn = useStaffStore(s => s.isAuthenticated);
  useEffect(() => {
    if (online && signedIn) void reportOfflineApprovals();
  }, [online, signedIn]);
  return null;
}
