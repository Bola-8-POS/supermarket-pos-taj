/**
 * Offline unlock for the signed-in staff member only.
 *
 * PIN checks run on the server. When the terminal is offline the idle lock
 * would otherwise be impossible to open, so it checks against the verifier
 * offline approval keeps for the signed-in staff member (offlineApproval.ts:
 * a salted PBKDF2 hash written at sign-in, valid 24 hours, surviving a
 * restart). Both share one attempt counter under the server's lockout
 * schedule (PIN_LOCKOUT).
 */
import { clearApprovalVerifier, rememberApprovalVerifier, verifyOfflinePin } from './offlineApproval';

export type OfflineUnlockResult = { ok: true } | { ok: false; retryAfter: number };

export const rememberOfflineUnlock = rememberApprovalVerifier;

export const clearOfflineUnlock = clearApprovalVerifier;

export async function checkOfflineUnlock(staffId: string, pin: string): Promise<OfflineUnlockResult> {
  const res = await verifyOfflinePin(staffId, pin);
  return res.ok ? { ok: true } : { ok: false, retryAfter: Math.ceil(res.retryAfterMs / 1000) };
}
