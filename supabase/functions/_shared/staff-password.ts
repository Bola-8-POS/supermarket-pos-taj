// The Supabase Auth password of a staff account is not the PIN: it is derived from the
// staff id and PIN with a server-only secret, so a PIN alone cannot be tried against the
// Auth API directly. scripts/lib/staff-password.ts is the Node twin; both are pinned by
// the same known-answer vectors.

export const STAFF_PASSWORD_VERSION = 'v1'
const MIN_PEPPER_LENGTH = 32
const MIN_PEPPER_DISTINCT = 8
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PIN = /^\d{6}$/

export class StaffPasswordConfigError extends Error {}

// Long AND varied: a run of one character (the all-zero buffer a failed generator leaves) is public.
function acceptablePepper(pepper: string): boolean {
  return pepper.length >= MIN_PEPPER_LENGTH && new Set(pepper).size >= MIN_PEPPER_DISTINCT
}

/** STAFF_PASSWORD_PEPPER when it is set, long enough and not low-entropy, else null. */
export function staffPasswordPepper(): string | null {
  const pepper = Deno.env.get('STAFF_PASSWORD_PEPPER') ?? ''
  return acceptablePepper(pepper) ? pepper : null
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function deriveStaffPassword(
  staffId: string,
  pin: string,
  pepper: string | null = staffPasswordPepper(),
): Promise<string> {
  if (!pepper || !acceptablePepper(pepper)) {
    throw new StaffPasswordConfigError('STAFF_PASSWORD_PEPPER is missing, shorter than 32 characters or low-entropy')
  }
  if (!UUID.test(staffId)) throw new TypeError('staffId must be a UUID')
  if (!PIN.test(pin)) throw new TypeError('pin must be 6 digits')
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const message = `barpos-staff-password|${STAFF_PASSWORD_VERSION}|${staffId.toLowerCase()}|${pin}`
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
  return `${STAFF_PASSWORD_VERSION}.${base64Url(mac)}`
}
