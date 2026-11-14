import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeToken,
  evaluateLicense,
  LEASE_WARN_DAYS,
  updatesExpired,
  verifyToken,
} from './token';
import type { LicensePayload } from './types';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-06T12:00:00Z');
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    tenant_id: 't-1',
    tenant_slug: 'demo',
    tenant_name: 'Demo',
    terminal_id: 'term-1',
    plan: 'monthly',
    status: 'active',
    period_end: iso(20),
    grace_days: 7,
    updates_until: null,
    max_terminals: 1,
    issued_at: iso(0),
    lease_until: iso(60),
    ...overrides,
  };
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

describe('evaluateLicense', () => {
  it('locks when there is no token', () => {
    expect(evaluateLicense(null, NOW)).toEqual({ state: 'locked', reason: 'unlicensed' });
  });

  it('is active well inside the period and lease', () => {
    expect(evaluateLicense(payload(), NOW)).toEqual({ state: 'active' });
  });

  it('warns 7 days before a monthly period ends, 30 days before a yearly one', () => {
    expect(evaluateLicense(payload({ period_end: iso(7) }), NOW)).toEqual({
      state: 'warning',
      kind: 'subscription',
      daysLeft: 7,
    });
    expect(evaluateLicense(payload({ period_end: iso(8) }), NOW)).toEqual({ state: 'active' });
    expect(evaluateLicense(payload({ plan: 'yearly', period_end: iso(30) }), NOW)).toEqual({
      state: 'warning',
      kind: 'subscription',
      daysLeft: 30,
    });
    expect(evaluateLicense(payload({ plan: 'yearly', period_end: iso(31) }), NOW)).toEqual({
      state: 'active',
    });
  });

  it('enters grace after period_end and restricts once grace_days pass', () => {
    expect(evaluateLicense(payload({ period_end: iso(-2) }), NOW)).toEqual({
      state: 'grace',
      daysLeft: 5,
    });
    expect(evaluateLicense(payload({ period_end: iso(-7) }), NOW)).toEqual({
      state: 'grace',
      daysLeft: 0,
    });
    expect(evaluateLicense(payload({ period_end: iso(-8) }), NOW)).toEqual({
      state: 'restricted',
      reason: 'subscription_expired',
    });
  });

  it('restricts when the offline lease expires, even with a paid subscription', () => {
    expect(evaluateLicense(payload({ lease_until: iso(-1), period_end: iso(300) }), NOW)).toEqual({
      state: 'restricted',
      reason: 'lease_expired',
    });
  });

  it('warns about the lease before it expires', () => {
    expect(
      evaluateLicense(payload({ lease_until: iso(LEASE_WARN_DAYS), period_end: iso(300) }), NOW)
    ).toEqual({
      state: 'warning',
      kind: 'lease',
      daysLeft: LEASE_WARN_DAYS,
    });
  });

  it('subscription warning wins over lease warning', () => {
    expect(evaluateLicense(payload({ lease_until: iso(3), period_end: iso(3) }), NOW)).toEqual({
      state: 'warning',
      kind: 'subscription',
      daysLeft: 3,
    });
  });

  it('suspended tenants are locked regardless of dates', () => {
    expect(evaluateLicense(payload({ status: 'suspended', period_end: iso(300) }), NOW)).toEqual({
      state: 'locked',
      reason: 'suspended',
    });
  });

  it('lifetime never expires but still honours the lease and flags ended updates', () => {
    const life = payload({ plan: 'lifetime', period_end: null, updates_until: iso(-1) });
    expect(evaluateLicense(life, NOW)).toEqual({ state: 'active' });
    expect(updatesExpired(life, NOW)).toBe(true);
    expect(
      updatesExpired(payload({ plan: 'lifetime', period_end: null, updates_until: iso(1) }), NOW)
    ).toBe(false);
    expect(updatesExpired(payload({ plan: 'yearly', updates_until: iso(-1) }), NOW)).toBe(false);
    expect(evaluateLicense({ ...life, lease_until: iso(-1) }, NOW)).toEqual({
      state: 'restricted',
      reason: 'lease_expired',
    });
  });

  it('a rolled-back clock (smaller now) cannot revive an expired lease when the caller passes max-seen', () => {
    const p = payload({ lease_until: iso(-1) });
    expect(evaluateLicense(p, Math.max(NOW - 30 * DAY, NOW))).toEqual({
      state: 'restricted',
      reason: 'lease_expired',
    });
  });

  it('demo plan past period_end locks with demo_expired regardless of grace', () => {
    expect(
      evaluateLicense(payload({ plan: 'demo', period_end: iso(-1), grace_days: 0 }), NOW)
    ).toEqual({ state: 'locked', reason: 'demo_expired' });
    expect(
      evaluateLicense(payload({ plan: 'demo', period_end: iso(-1), grace_days: 7 }), NOW)
    ).toEqual({ state: 'locked', reason: 'demo_expired' });
    expect(
      evaluateLicense(
        payload({ plan: 'demo', period_end: new Date(NOW - 3_600_000).toISOString() }),
        NOW
      )
    ).toEqual({ state: 'locked', reason: 'demo_expired' });
  });

  it('returns restricted, not locked, when a paid lease has expired', () => {
    const res = evaluateLicense(payload({ lease_until: iso(-1) }), NOW, 0);
    expect(res).toMatchObject({ state: 'restricted', reason: 'lease_expired' });
  });

  it('returns restricted when the subscription grace has run out', () => {
    const res = evaluateLicense(payload({ period_end: iso(-30), grace_days: 7 }), NOW, 0);
    expect(res).toMatchObject({ state: 'restricted', reason: 'subscription_expired' });
  });

  it('still hard-locks an unlicensed terminal', () => {
    expect(evaluateLicense(null, NOW, 0)).toMatchObject({ state: 'locked', reason: 'unlicensed' });
  });

  it('still hard-locks a suspended tenant', () => {
    expect(evaluateLicense(payload({ status: 'suspended' }), NOW, 0)).toMatchObject({ state: 'locked', reason: 'suspended' });
  });

  it('still hard-locks a suspended tenant whose lease has also expired', () => {
    expect(evaluateLicense(payload({ status: 'suspended', lease_until: iso(-1) }), NOW, 1)).toMatchObject({
      state: 'locked', reason: 'suspended',
    });
  });

  it('still hard-locks an expired demo', () => {
    expect(evaluateLicense(payload({ plan: 'demo', period_end: iso(-1) }), NOW, 0)).toMatchObject({
      state: 'locked', reason: 'demo_expired',
    });
  });

  it('keeps hard-locking a demo whose lease or offline budget ran out', () => {
    expect(evaluateLicense(payload({ plan: 'demo', lease_until: iso(-1) }), NOW, 0)).toEqual({
      state: 'locked', reason: 'lease_expired',
    });
    expect(evaluateLicense(payload({ plan: 'demo' }), NOW, 1)).toEqual({
      state: 'locked', reason: 'offline_budget_spent',
    });
  });

  it('restricts when the offline runtime budget is spent even though the lease looks valid', () => {
    const res = evaluateLicense(payload({ lease_until: iso(30) }), NOW, 1.0);
    expect(res).toMatchObject({ state: 'restricted', reason: 'offline_budget_spent' });
  });

  it('a spent budget restricts even inside the subscription grace window', () => {
    expect(evaluateLicense(payload({ period_end: iso(-2) }), NOW, 1)).toEqual({
      state: 'restricted', reason: 'offline_budget_spent',
    });
  });

  it('warns when the budget is more than half spent', () => {
    const res = evaluateLicense(payload({ lease_until: iso(30) }), NOW, 0.6);
    expect(res).toMatchObject({ state: 'warning', kind: 'offline_budget' });
  });

  it('does not warn about revalidation for a store that cannot heartbeat (offline token)', () => {
    expect(evaluateLicense(payload({ lease_until: iso(30) }), NOW, 0.6, false)).toEqual({ state: 'active' });
  });

  it('does not warn at exactly half the budget', () => {
    expect(evaluateLicense(payload({ lease_until: iso(30) }), NOW, 0.5)).toEqual({ state: 'active' });
  });

  it('defaults the budget argument to untouched', () => {
    expect(evaluateLicense(payload(), NOW)).toEqual({ state: 'active' });
  });

  it('demo plan inside its period is active with no subscription warning', () => {
    expect(evaluateLicense(payload({ plan: 'demo', period_end: iso(2), grace_days: 0 }), NOW))
      .toEqual({ state: 'active' });
    expect(evaluateLicense(payload({ plan: 'demo', period_end: iso(0) }), NOW)).toEqual({
      state: 'active',
    });
    expect(
      evaluateLicense(
        payload({ plan: 'demo', period_end: new Date(NOW + 3_600_000).toISOString() }),
        NOW
      )
    ).toEqual({ state: 'active' });
  });

  it('decodeToken accepts a payload carrying a features allow-list', () => {
    const p = { ...payload(), features: ['promotions'] };
    const token = `${b64url(Buffer.from(JSON.stringify(p)))}.${b64url(Buffer.from('sig'))}`;
    const res = decodeToken(token);
    expect(res.ok && res.data.features).toEqual(['promotions']);
  });
});

describe('verifyToken / decodeToken', () => {
  let spki: string;
  let sign: (p: LicensePayload) => Promise<string>;

  beforeAll(async () => {
    const { subtle } = webcrypto;
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    spki = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('base64');
    sign = async p => {
      const body = new TextEncoder().encode(JSON.stringify(p));
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, body);
      return `${b64url(body)}.${b64url(sig)}`;
    };
  });

  it('accepts a token signed by the matching private key', async () => {
    const res = await verifyToken(await sign(payload()), spki);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.tenant_slug).toBe('demo');
  });

  it('rejects a tampered payload and a token signed by another key', async () => {
    const token = await sign(payload());
    const [, sig] = token.split('.');
    const tampered = `${b64url(new TextEncoder().encode(JSON.stringify(payload({ period_end: iso(3650) }))))}.${sig}`;
    expect((await verifyToken(tampered, spki)).ok).toBe(false);

    const other = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const otherSpki = Buffer.from(
      await webcrypto.subtle.exportKey('spki', other.publicKey)
    ).toString('base64');
    expect((await verifyToken(token, otherSpki)).ok).toBe(false);
  });

  it('rejects malformed input without throwing', async () => {
    expect((await verifyToken('garbage', spki)).ok).toBe(false);
    expect((await verifyToken('a.b', spki)).ok).toBe(false);
    expect(decodeToken('not-a-token').ok).toBe(false);
  });

  it('decodeToken parses without checking the signature', () => {
    const body = b64url(new TextEncoder().encode(JSON.stringify(payload())));
    const res = decodeToken(`${body}.AAAA`);
    expect(res.ok).toBe(true);
  });
});
