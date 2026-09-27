import { err, ok, type Result } from '@shared/lib/result';
import { LICENSE_PUBLIC_KEY_SPKI } from './public-key';
import {
  LicensePayloadSchema,
  type LicenseEvaluation,
  type LicensePayload,
  type LicensePlan,
} from './types';

const DAY_MS = 86_400_000;

/** Days before period_end at which the amber "renew soon" banner appears. */
export const SUBSCRIPTION_WARN_DAYS: Record<LicensePlan, number> = {
  monthly: 7,
  yearly: 30,
  lifetime: 0,
  demo: 0,
};
/** Days before lease_until at which an offline terminal is warned to reconnect / re-license. */
export const LEASE_WARN_DAYS = 7;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function invalid(message: string): Result<never> {
  return err({ code: 'LICENSE_ERROR', message });
}

/** Parse the payload half of a token WITHOUT checking the signature. */
export function decodeToken(token: string): Result<LicensePayload> {
  const [payloadPart, sigPart] = token.trim().split('.');
  if (!payloadPart || !sigPart) return invalid('Malformed license token');
  try {
    const parsed = LicensePayloadSchema.safeParse(
      JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadPart)))
    );
    return parsed.success ? ok(parsed.data) : invalid('License token has an unexpected shape');
  } catch {
    return invalid('License token is not valid base64/JSON');
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function publicKey(spkiB64: string): Promise<CryptoKey> {
  let p = keyCache.get(spkiB64);
  if (!p) {
    p = crypto.subtle.importKey(
      'spki',
      b64urlToBytes(spkiB64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    keyCache.set(spkiB64, p);
  }
  return p;
}

/** Verify the ECDSA-P256/SHA-256 signature and parse the payload. Works fully offline. */
export async function verifyToken(
  token: string,
  spkiB64: string = LICENSE_PUBLIC_KEY_SPKI
): Promise<Result<LicensePayload>> {
  const [payloadPart, sigPart] = token.trim().split('.');
  if (!payloadPart || !sigPart) return invalid('Malformed license token');
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await publicKey(spkiB64),
      b64urlToBytes(sigPart),
      b64urlToBytes(payloadPart)
    );
  } catch {
    valid = false;
  }
  if (!valid) return invalid('License token signature is invalid');
  return decodeToken(token);
}

const daysUntil = (iso: string, now: number): number =>
  Math.ceil((new Date(iso).getTime() - now) / DAY_MS);

/**
 * Pure policy: token payload + wall clock → what the app may do right now.
 * `now` should be the clock-rollback-resistant value from the store (max seen).
 */
export function evaluateLicense(payload: LicensePayload | null, now: number): LicenseEvaluation {
  if (!payload) return { state: 'locked', reason: 'unlicensed' };
  if (payload.status === 'suspended') return { state: 'locked', reason: 'suspended' };

  const leaseDays = daysUntil(payload.lease_until, now);
  if (leaseDays < 0) return { state: 'locked', reason: 'lease_expired' };

  if (payload.period_end !== null) {
    if (payload.plan === 'demo') {
      // Demos have no grace and no "days left" warning banner — check the exact instant
      // rather than the day-ceiling `daysUntil` used for paid-plan grace/warning math below,
      // so an expiry a few hours into "today" locks immediately instead of waiting for
      // daysUntil's Math.ceil to roll over to a whole negative day.
      if (new Date(payload.period_end).getTime() < now) {
        return { state: 'locked', reason: 'demo_expired' };
      }
    } else {
      const periodDays = daysUntil(payload.period_end, now);
      if (periodDays < 0) {
        const graceLeft = payload.grace_days + periodDays;
        if (graceLeft < 0) return { state: 'locked', reason: 'subscription_expired' };
        return { state: 'grace', daysLeft: graceLeft };
      }
      if (periodDays <= SUBSCRIPTION_WARN_DAYS[payload.plan]) {
        return { state: 'warning', kind: 'subscription', daysLeft: periodDays };
      }
    }
  }

  if (leaseDays <= LEASE_WARN_DAYS) return { state: 'warning', kind: 'lease', daysLeft: leaseDays };
  return { state: 'active' };
}

/** Lifetime plans stop receiving updates after updates_until; subscriptions always do. */
export function updatesExpired(payload: LicensePayload | null, now: number): boolean {
  if (!payload || payload.plan !== 'lifetime' || !payload.updates_until) return false;
  return new Date(payload.updates_until).getTime() < now;
}
