/**
 * Node twin of supabase/functions/_shared/staff-password.ts. Scripts, e2e helpers and
 * integration tests use it to set or sign in with a staff account's Auth password, which is
 * derived from the staff id and PIN, never the PIN itself. Pinned to the Deno version by the
 * same known-answer vectors (src/shared/lib/__tests__/staff-password-parity.test.ts).
 *
 * The secret comes from STAFF_PASSWORD_PEPPER. Only when the target is a loopback address
 * (VITE_SUPABASE_URL / SUPABASE_URL) does it fall back to the local supabase/functions/.env, so a
 * run against a hosted project can never silently use the dev pepper.
 * WARNING: server/test only — never import this in the renderer.
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STAFF_PASSWORD_VERSION = 'v1';
const MIN_PEPPER_LENGTH = 32;
const MIN_PEPPER_DISTINCT = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN = /^\d{6}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class StaffPasswordConfigError extends Error {}

// Long AND varied: a run of one character (the all-zero buffer a failed generator leaves) is public.
function acceptablePepper(pepper: string): boolean {
  return pepper.length >= MIN_PEPPER_LENGTH && new Set(pepper).size >= MIN_PEPPER_DISTINCT;
}

function targetIsLoopback(): boolean {
  const raw = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!raw) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * STAFF_PASSWORD_PEPPER from the environment, else (loopback targets only) from
 * `<root>/supabase/functions/.env`; null when missing, short or low-entropy.
 */
export function resolveStaffPasswordPepper(root: string = process.cwd()): string | null {
  const fromEnv = process.env.STAFF_PASSWORD_PEPPER;
  if (fromEnv) return acceptablePepper(fromEnv) ? fromEnv : null;
  if (!targetIsLoopback()) return null;
  const file = join(root, 'supabase', 'functions', '.env');
  if (!existsSync(file)) return null;
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('STAFF_PASSWORD_PEPPER='));
  const value = (line?.slice('STAFF_PASSWORD_PEPPER='.length) ?? '').trim().replace(/^["']|["']$/g, '');
  return acceptablePepper(value) ? value : null;
}

export async function deriveStaffPassword(
  staffId: string,
  pin: string,
  pepper: string | null = resolveStaffPasswordPepper(),
): Promise<string> {
  if (!pepper || !acceptablePepper(pepper)) {
    throw new StaffPasswordConfigError('STAFF_PASSWORD_PEPPER is missing, shorter than 32 characters or low-entropy');
  }
  if (!UUID.test(staffId)) throw new TypeError('staffId must be a UUID');
  if (!PIN.test(pin)) throw new TypeError('pin must be 6 digits');
  const mac = createHmac('sha256', Buffer.from(pepper, 'utf8'))
    .update(`barpos-staff-password|${STAFF_PASSWORD_VERSION}|${staffId.toLowerCase()}|${pin}`, 'utf8')
    .digest('base64url');
  return `${STAFF_PASSWORD_VERSION}.${mac}`;
}
