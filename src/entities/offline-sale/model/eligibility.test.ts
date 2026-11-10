import { describe, expect, it } from 'vitest';
import { evaluateOfflineEligibility, type OfflineEligibilityInput } from './eligibility';

const base: OfflineEligibilityInput = {
  method: 'cash',
  legs: undefined,
  referenceNumber: undefined,
  hasDiscount: false,
  hasOverride: false,
  licenseState: 'active',
  requiresRevalidation: false,
  isCajaOpen: true,
  limit: { ok: true },
};
const check = (o: Partial<OfflineEligibilityInput>) => evaluateOfflineEligibility({ ...base, ...o });

describe('offline eligibility', () => {
  it('eligibility matrix', () => {
    expect(check({})).toEqual({ ok: true });
    expect(check({ method: 'card' })).toEqual({ ok: false, reason: 'card_reference_missing' });
    expect(check({ method: 'card', referenceNumber: '  ' })).toEqual({
      ok: false,
      reason: 'card_reference_missing',
    });
    expect(check({ method: 'card', referenceNumber: 'AUTH-1' })).toEqual({ ok: true });
    expect(
      check({
        method: undefined,
        legs: [{ method: 'cash' }, { method: 'card', referenceNumber: 'AUTH-1' }],
      })
    ).toEqual({ ok: true });
    expect(check({ method: undefined, legs: [{ method: 'cash' }, { method: 'card' }] })).toEqual({
      ok: false,
      reason: 'card_reference_missing',
    });
    expect(
      check({ method: undefined, legs: [{ method: 'cash' }, { method: 'bank_transfer' }] })
    ).toEqual({ ok: false, reason: 'split_method' });
    expect(check({ method: 'bank_transfer' })).toEqual({ ok: false, reason: 'method' });
    expect(check({ method: 'rappi' })).toEqual({ ok: false, reason: 'method' });
    expect(check({ method: 'uber_eats' })).toEqual({ ok: false, reason: 'method' });
    expect(check({ instanceRole: 'secondary' })).toEqual({ ok: false, reason: 'secondary_instance' });
    expect(check({ instanceRole: 'unknown' })).toEqual({ ok: false, reason: 'secondary_instance' });
    expect(check({ instanceRole: 'primary' })).toEqual({ ok: true });
    expect(check({ isReRing: true })).toEqual({ ok: false, reason: 'rering' });
    expect(check({ isReRing: false })).toEqual({ ok: true });
    expect(check({ hasDiscount: true })).toEqual({ ok: false, reason: 'discount' });
    expect(check({ hasOverride: true })).toEqual({ ok: false, reason: 'override' });
    expect(check({ licenseState: 'restricted' })).toEqual({ ok: false, reason: 'license' });
    expect(check({ licenseState: 'locked' })).toEqual({ ok: false, reason: 'license' });
    expect(check({ requiresRevalidation: true })).toEqual({ ok: false, reason: 'revalidation' });
    expect(check({ isCajaOpen: false })).toEqual({ ok: false, reason: 'no_open_caja' });
    expect(check({ limit: { ok: false, reason: 'count' } })).toEqual({
      ok: false,
      reason: 'limit',
    });
  });

  it('licence states that still allow a sale', () => {
    for (const licenseState of ['active', 'warning', 'grace', 'disabled'] as const) {
      expect(check({ licenseState })).toEqual({ ok: true });
    }
  });

  it('a request with neither method nor legs is not eligible', () => {
    expect(check({ method: undefined })).toEqual({ ok: false, reason: 'method' });
  });
});
