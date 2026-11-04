/**
 * Offline approval for a terminal with no connectivity.
 *
 * Two pieces of local state:
 *  - The signed-in staff member's PIN verifier: a salted PBKDF2 hash written
 *    at sign-in, valid for 24 hours, with its failed-attempt counter in the
 *    same record so a reload cannot reset the lockout. Never the PIN itself.
 *    Persisted in localStorage, except an admin's, which stays in memory.
 *    It also backs the idle lock's offline unlock (offlineUnlock.ts).
 *  - Pre-authorised grants: single-use approvals a manager issued online to
 *    this terminal for one action (issue_offline_approval_grants). Offline,
 *    the signed-in staff member redeems one by typing their own PIN; the
 *    grant id then stands in for the server's approval ticket, and the use
 *    is logged until reported back (report_offline_approvals).
 *
 * See docs/superpowers/specs/2026-09-29-offline-approval-scope.md.
 */
import { z } from 'zod';

import type { UserRole } from '@shared/lib/domain';
import { isIdleReset, nextRetryAfterMs } from '@shared/lib/pin-lockout';
// The business terminal id (Settings → Hardware, e.g. POS-1), deliberately not
// the licence installation UUID of the same name in @shared/lib/license/terminal-id:
// grants are issued to a till, and the server records them against this id.
import { getTerminalId } from '@shared/lib/terminal';

/* eslint-disable i18next/no-literal-string -- storage keys and WebCrypto names, not UI copy */
const VERIFIER_KEY = 'pos.offline_approval';
const GRANTS_KEY = 'pos.offline_grants';
const USES_KEY = 'pos.offline_grant_uses';
/* eslint-enable i18next/no-literal-string */

const ITERATIONS = 310_000;
const VERIFIER_TTL_MS = 24 * 60 * 60 * 1000;

const StoredVerifierSchema = z.object({
  approverId: z.string(),
  saltB64: z.string(),
  hashB64: z.string(),
  iterations: z.number().int().positive(),
  createdAt: z.number(),
  expiresAt: z.number(),
  failedAttempts: z.number().int().min(0),
  lastAttemptAt: z.number(),
});
type StoredVerifier = z.infer<typeof StoredVerifierSchema>;

const OfflineGrantSchema = z.object({
  id: z.string(),
  action: z.string(),
  grantedBy: z.string(),
  // The cashier the grant was issued for; only that signed-in user can offer or redeem it.
  requestedFor: z.string(),
  expiresAt: z.number(),
  terminalId: z.string(),
});
export type OfflineGrant = z.infer<typeof OfflineGrantSchema>;

const OfflineApprovalSchema = z.object({
  grantId: z.string(),
  action: z.string(),
  grantedBy: z.string(),
  usedBy: z.string(),
  usedAt: z.number(),
  terminalId: z.string(),
});
export type OfflineApproval = z.infer<typeof OfflineApprovalSchema>;

export type OfflinePinFailure = {
  ok: false;
  reason: 'no_verifier' | 'wrong_pin' | 'locked_out' | 'expired';
  retryAfterMs: number;
};
export type OfflinePinResult = { ok: true } | OfflinePinFailure;
export type OfflineApprovalResult =
  | { ok: true; approval: OfflineApproval }
  | OfflinePinFailure
  | { ok: false; reason: 'no_grant'; retryAfterMs: number };

function read<T>(key: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ponytail: storage unavailable — offline approval simply stays unavailable */
  }
}

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  /* eslint-disable i18next/no-literal-string -- WebCrypto key format/algorithm names */
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    256
  );
  /* eslint-enable i18next/no-literal-string */
  return toB64(new Uint8Array(bits));
}

function lockRemainingMs(v: StoredVerifier, now: number): number {
  if (isIdleReset(v.lastAttemptAt, now)) return 0;
  return Math.max(0, v.lastAttemptAt + nextRetryAfterMs(v.failedAttempts) - now);
}

/**
 * An admin's verifier lives in memory only (owner decision, 2026-10-01): a
 * persisted hash of a 6-digit PIN cracks in about a minute, and an admin's PIN
 * is the most valuable sign-in credential on the terminal. After a restart an
 * admin signs in online again before anything works offline.
 */
let memoryVerifier: StoredVerifier | null = null;

function readVerifier(): StoredVerifier | null {
  return memoryVerifier ?? read(VERIFIER_KEY, StoredVerifierSchema);
}

function writeVerifier(v: StoredVerifier): void {
  if (memoryVerifier) memoryVerifier = v;
  else write(VERIFIER_KEY, v);
}

/** Seeds (or replaces) the verifier for the staff member who just signed in. */
export async function rememberApprovalVerifier(staffId: string, pin: string, role: UserRole): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const now = Date.now();
  const record: StoredVerifier = {
    approverId: staffId,
    saltB64: toB64(salt),
    hashB64: await derive(pin, salt, ITERATIONS),
    iterations: ITERATIONS,
    createdAt: now,
    expiresAt: now + VERIFIER_TTL_MS,
    failedAttempts: 0,
    lastAttemptAt: 0,
  };
  clearApprovalVerifier();
  if (role === 'admin') memoryVerifier = record;
  else write(VERIFIER_KEY, record);
}

export function clearApprovalVerifier(): void {
  memoryVerifier = null;
  try {
    localStorage.removeItem(VERIFIER_KEY);
  } catch {
    /* ponytail: storage unavailable — nothing was stored */
  }
}

/** Checks `pin` for `staffId` against the verifier, under the shared lockout schedule. */
export async function verifyOfflinePin(staffId: string, pin: string): Promise<OfflinePinResult> {
  const v = readVerifier();
  if (!v) return { ok: false, reason: 'no_verifier', retryAfterMs: 0 };
  const now = Date.now();
  if (now >= v.expiresAt) {
    clearApprovalVerifier();
    return { ok: false, reason: 'expired', retryAfterMs: 0 };
  }
  const wait = lockRemainingMs(v, now);
  if (wait > 0) return { ok: false, reason: 'locked_out', retryAfterMs: wait };

  if (v.approverId === staffId && (await derive(pin, fromB64(v.saltB64), v.iterations)) === v.hashB64) {
    writeVerifier({ ...v, failedAttempts: 0, lastAttemptAt: 0 });
    return { ok: true };
  }
  // Re-read after the slow derive so a concurrent attempt is not overwritten.
  const cur = readVerifier() ?? v;
  const failedAttempts = isIdleReset(cur.lastAttemptAt, now) ? 1 : cur.failedAttempts + 1;
  writeVerifier({ ...cur, failedAttempts, lastAttemptAt: now });
  return { ok: false, reason: 'wrong_pin', retryAfterMs: nextRetryAfterMs(failedAttempts) };
}

function readGrants(): OfflineGrant[] {
  return read(GRANTS_KEY, z.array(OfflineGrantSchema)) ?? [];
}

/** Adds grants issued to this terminal, dropping expired ones on the way. */
export function storeOfflineGrants(grants: OfflineGrant[]): void {
  const now = Date.now();
  const byId = new Map([...readGrants(), ...grants].map(g => [g.id, g]));
  write(GRANTS_KEY, [...byId.values()].filter(g => g.expiresAt > now));
}

/** Unexpired grants issued to this terminal for the signed-in cashier, soonest-expiring first. */
export function availableOfflineGrants(action?: string): OfflineGrant[] {
  const now = Date.now();
  const terminalId = getTerminalId();
  const me = readVerifier()?.approverId;
  if (!me) return [];
  return readGrants()
    .filter(g => g.expiresAt > now && g.terminalId === terminalId && g.requestedFor === me && (action === undefined || g.action === action))
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/**
 * Redeems one grant for `action`, after the signed-in staff member's PIN
 * passes the verifier. A missing grant is refused before the PIN is checked,
 * so it never costs a lockout attempt.
 */
export async function approveOffline(action: string, pin: string): Promise<OfflineApprovalResult> {
  const v = readVerifier();
  if (!v) return { ok: false, reason: 'no_verifier', retryAfterMs: 0 };
  const grant = availableOfflineGrants(action)[0];
  if (!grant) return { ok: false, reason: 'no_grant', retryAfterMs: 0 };

  const pinCheck = await verifyOfflinePin(v.approverId, pin);
  if (!pinCheck.ok) return pinCheck;

  write(GRANTS_KEY, readGrants().filter(g => g.id !== grant.id));
  const approval: OfflineApproval = {
    grantId: grant.id,
    action,
    grantedBy: grant.grantedBy,
    usedBy: v.approverId,
    usedAt: Date.now(),
    terminalId: grant.terminalId,
  };
  write(USES_KEY, [...pendingGrantUses(), approval]);
  return { ok: true, approval };
}

/** Offline uses not yet reported to the server. */
export function pendingGrantUses(): OfflineApproval[] {
  return read(USES_KEY, z.array(OfflineApprovalSchema)) ?? [];
}

export function markGrantUsesReported(grantIds: string[]): void {
  const done = new Set(grantIds);
  write(USES_KEY, pendingGrantUses().filter(u => !done.has(u.grantId)));
}

/**
 * Applies a freshly fetched staff directory (active staff only): a signed-in
 * staff member who is gone loses their verifier, and grants from an issuer
 * who is gone are dropped. An empty directory is ignored — it can only mean a
 * bad fetch, since the signed-in staff member is always in it.
 */
export function revokeIfInactive(directory: ReadonlyArray<{ id: string; isActive: boolean }>): void {
  if (directory.length === 0) return;
  const active = new Set(directory.filter(s => s.isActive).map(s => s.id));
  const v = readVerifier();
  if (v && !active.has(v.approverId)) clearApprovalVerifier();
  const grants = readGrants();
  const kept = grants.filter(g => active.has(g.grantedBy));
  if (kept.length !== grants.length) write(GRANTS_KEY, kept);
}
