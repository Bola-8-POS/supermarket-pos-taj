/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// Pre-regen cast: terminal_lock_settings/record_audit's new actions added in
// Phase 21; supabase.types.ts not yet regenerated (CLAUDE.md workaround).
import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';

// record_audit's `screen.lock`/`screen.unlock` actions are called directly
// from the client (existing precedent: toggle-permission, force-pin-change,
// lookup-product-by-barcode) rather than typed through supabase.types.ts.
const db = supabase as any;

interface StaffIdentity {
  id: string;
  name: string;
}

// Module-level (not defined inside the hook) so `recordLock`/`recordUnlock`
// are referentially stable across renders -- no closure over component state,
// only module-level `db` and call-time params/getTerminalId() calls, so this
// is safe and keeps IdleLockProvider's useCallback/useIdleTimer deps from
// churning the idle-timer's window-listener subscription on every render.
async function recordLock(sessionOwner: StaffIdentity | null, shiftId: string | null): Promise<void> {
  const auditRes = await db.rpc('record_audit', {
    p_action: 'screen.lock',
    p_entity_type: 'shift',
    p_entity_id: shiftId,
    p_before: null,
    p_after: {
      sessionOwnerStaffId: sessionOwner?.id ?? null,
      sessionOwnerStaffName: sessionOwner?.name ?? null,
    },
    p_source: 'client',
    p_terminal_id: getTerminalId(),
    p_user_id: null,
  });
  if (auditRes?.error) {
    logger.warn('screen.lock.audit_failed', { message: auditRes.error.message });
  }
}

async function recordUnlock(
  sessionOwner: StaffIdentity | null,
  unlockedBy: StaffIdentity,
  shiftId: string | null
): Promise<void> {
  const auditRes = await db.rpc('record_audit', {
    p_action: 'screen.unlock',
    p_entity_type: 'shift',
    p_entity_id: shiftId,
    p_before: {
      sessionOwnerStaffId: sessionOwner?.id ?? null,
      sessionOwnerStaffName: sessionOwner?.name ?? null,
    },
    p_after: {
      unlockedByStaffId: unlockedBy.id,
      unlockedByStaffName: unlockedBy.name,
    },
    p_source: 'client',
    p_terminal_id: getTerminalId(),
    p_user_id: null,
  });
  if (auditRes?.error) {
    logger.warn('screen.unlock.audit_failed', { message: auditRes.error.message });
  }
}

/**
 * Writes the `screen.lock`/`screen.unlock` audit trail (D-05). The Supabase
 * Auth session never changes across a lock/unlock cycle (Pitfall 1/2), so
 * `actor_id` is identical for both events and cannot express "who unlocked"
 * -- the session-owner and unlocking-staff identities are recorded
 * explicitly in `p_before`/`p_after` JSON instead. Audit failures never
 * block the lock/unlock UX itself (logger.warn, not err()).
 */
export function useIdleLockAudit() {
  return { recordLock, recordUnlock };
}
