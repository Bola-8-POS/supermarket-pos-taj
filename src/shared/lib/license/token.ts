import { err, ok, type Result } from '@shared/lib/result';
import { OFFLINE_BUDGET_HOURS, REVALIDATE_AT_FRACTION } from './offline-budget';
import { LICENSE_PUBLIC_KEY_SPKI } from './public-key';
import {
  LicensePayloadSchema,
  type LicenseEvaluation,
  type LicensePayload,
  type LicensePlan,
  type LicenseRestrictReason,
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
 * Pure policy: token payload + wall clock + offline runtime → what the app may do right now.
 * `now` should be the clock-rollback-resistant value from the store (max seen);
 * `budgetConsumed` is budgetConsumedFraction() of the store's offline budget, and
 * `canRevalidate` is false for a store that cannot heartbeat (offline token): it gets no
 * "sales pause on reconnection" warning because nothing would ever clear it.
 *
 * A paid store whose lease, subscription or offline budget ran out is `restricted` (it can sign in
 * and close its caja, not sell); demos and everything else that is not "a licensed store that lost
 * contact" stay hard-`locked`. Policy: docs/superpowers/specs/2026-09-29-offline-licensing-policy.md.
 */
export function evaluateLicense(
  payload: LicensePayload | null,
  now: number,
  budgetConsumed = 0,
  canRevalidate = true
): LicenseEvaluation {
  if (!payload) return { state: 'locked', reason: 'unlicensed' };
  if (payload.status === 'suspended') return { state: 'locked', reason: 'suspended' };

  const restrict = (reason: LicenseRestrictReason): LicenseEvaluation =>
    payload.plan === 'demo' ? { state: 'locked', reason } : { state: 'restricted', reason };

  const leaseDays = daysUntil(payload.lease_until, now);
  if (leaseDays < 0) return restrict('lease_expired');

  let graceLeft: number | null = null;
  let subscriptionWarnDays: number | null = null;
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
        graceLeft = payload.grace_days + periodDays;
        if (graceLeft < 0) return restrict('subscription_expired');
      } else if (periodDays <= SUBSCRIPTION_WARN_DAYS[payload.plan]) {
        subscriptionWarnDays = periodDays;
      }
    }
  }

  if (budgetConsumed >= 1) return restrict('offline_budget_spent');
  if (graceLeft !== null) return { state: 'grace', daysLeft: graceLeft };
  if (canRevalidate && budgetConsumed > REVALIDATE_AT_FRACTION) {
    const hoursLeft = (1 - budgetConsumed) * OFFLINE_BUDGET_HOURS;
    return { state: 'warning', kind: 'offline_budget', daysLeft: Math.ceil(hoursLeft / 24) };
  }
  if (subscriptionWarnDays !== null) {
    return { state: 'warning', kind: 'subscription', daysLeft: subscriptionWarnDays };
  }
  if (leaseDays <= LEASE_WARN_DAYS) return { state: 'warning', kind: 'lease', daysLeft: leaseDays };
  return { state: 'active' };
}

/** Lifetime plans stop receiving updates after updates_until; subscriptions always do. */
export function updatesExpired(payload: LicensePayload | null, now: number): boolean {
  if (!payload || payload.plan !== 'lifetime' || !payload.updates_until) return false;
  return new Date(payload.updates_until).getTime() < now;
}
