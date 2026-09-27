/**
 * Offline unlock for the signed-in staff member only.
 *
 * PIN checks run on the server. When the terminal is offline the idle lock
 * would otherwise be impossible to open, so the PIN typed at sign-in is kept
 * as a salted PBKDF2 hash, in memory only (never persisted; gone after a
 * restart, after which unlocking needs a connection).
 * Attempts are limited with the same schedule as the server-side check: four free, then 30 s doubling per attempt up to 15 minutes, starting over after 30 minutes without an attempt.
 */
const ITERATIONS = 310_000;

const FREE_ATTEMPTS = 4;
const BASE_LOCK_S = 30;
const MAX_LOCK_S = 900;
const RESET_AFTER_MS = 30 * 60_000;

export type OfflineUnlockResult = { ok: true } | { ok: false; retryAfter: number };

let remembered: { staffId: string; salt: Uint8Array; hash: string } | null = null;
let attempts: { failed: number; lockedUntil: number; updatedAt: number } = { failed: 0, lockedUntil: 0, updatedAt: 0 };

async function derive(pin: string, salt: Uint8Array): Promise<string> {
  // eslint-disable-next-line i18next/no-literal-string -- WebCrypto key format/algorithm names
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    // eslint-disable-next-line i18next/no-literal-string -- WebCrypto algorithm names
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    material,
    256
  );
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
}

function resetAttempts(): void {
  attempts = { failed: 0, lockedUntil: 0, updatedAt: 0 };
}

/** Seconds still locked, or 0. */
function retryAfter(now: number): number {
  return attempts.lockedUntil > now ? Math.ceil((attempts.lockedUntil - now) / 1000) : 0;
}

function recordFailure(now: number): number {
  attempts.failed = now - attempts.updatedAt > RESET_AFTER_MS ? 1 : attempts.failed + 1;
  attempts.updatedAt = now;
  if (attempts.failed <= FREE_ATTEMPTS) return 0;
  const lock = Math.min(MAX_LOCK_S, BASE_LOCK_S * 2 ** Math.min(attempts.failed - FREE_ATTEMPTS - 1, 5));
  attempts.lockedUntil = now + lock * 1000;
  return lock;
}

export async function rememberOfflineUnlock(staffId: string, pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  remembered = { staffId, salt, hash: await derive(pin, salt) };
  resetAttempts();
}

export async function checkOfflineUnlock(staffId: string, pin: string): Promise<OfflineUnlockResult> {
  const now = Date.now();
  const wait = retryAfter(now);
  if (wait > 0) return { ok: false, retryAfter: wait };
  if (remembered && remembered.staffId === staffId && (await derive(pin, remembered.salt)) === remembered.hash) {
    resetAttempts();
    return { ok: true };
  }
  return { ok: false, retryAfter: recordFailure(now) };
}

export function clearOfflineUnlock(): void {
  remembered = null;
  resetAttempts();
}
