import { describe, expect, it } from 'vitest';
import { CheckoutDraftSchema } from '@shared/lib/domain';
import {
  discountFromDraftValue,
  discountToDraftValue,
  sanitizeCheckoutDraft,
  type PaymentDraftInput,
} from './checkoutDraft';

const MAX_CENTS = Number.MAX_SAFE_INTEGER;
const base: PaymentDraftInput = {
  method: 'cash',
  tenderedCents: 1000,
  splitLegs: [],
  discount: null,
  reference: '',
};

describe('sanitizeCheckoutDraft', () => {
  it('returns only method, tenderedCents, splitLegs, discount and reference', () => {
    const out = sanitizeCheckoutDraft(base);
    expect(Object.keys(out).sort()).toEqual(['discount', 'method', 'reference', 'splitLegs', 'tenderedCents']);
  });

  it('drops a reference that looks like a card number', () => {
    expect(sanitizeCheckoutDraft({ ...base, method: 'card', reference: '4111 1111 1111 1111' }).reference).toBeNull();
    expect(sanitizeCheckoutDraft({ ...base, method: 'card', reference: 'AB1234' }).reference).toBe('AB1234');
  });

  it('drops a long digit run (a PAN typed so far) but keeps a 6-digit approval code', () => {
    expect(sanitizeCheckoutDraft({ ...base, method: 'card', reference: '4111 1111' }).reference).toBeNull();
    expect(sanitizeCheckoutDraft({ ...base, method: 'card', reference: '482913' }).reference).toBe('482913');
  });

  it('never outputs pin, approval ticket, managerOverride or authorizingManager even when the input has them', () => {
    const dirty = {
      ...base,
      pin: '000000',
      approvalId: 'ticket',
      managerOverride: true,
      authorizingManager: { id: 'x', approvalId: 'y' },
    } as PaymentDraftInput;
    const json = JSON.stringify(sanitizeCheckoutDraft(dirty));
    for (const forbidden of ['pin', 'approval', 'managerOverride', 'authorizingManager', 'ticket']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it.each([0, MAX_CENTS])('round-trips tendered %i unchanged', tenderedCents => {
    expect(sanitizeCheckoutDraft({ ...base, tenderedCents }).tenderedCents).toBe(tenderedCents);
  });

  it.each([-1, 0, 1])('round-trips split sums at total %i cents, legs in order', delta => {
    const total = 2000 + delta;
    const legs = [
      { method: 'cash' as const, amountCents: 1 },
      { method: 'card' as const, amountCents: total - 1 },
    ];
    const out = sanitizeCheckoutDraft({ ...base, splitLegs: legs });
    expect(out.splitLegs).toEqual(legs);
    expect(out.splitLegs.reduce((s, l) => s + l.amountCents, 0)).toBe(total);
  });

  it('outputs integer cents that pass CheckoutDraftSchema', () => {
    const out = sanitizeCheckoutDraft({ ...base, tenderedCents: 1234.9, discount: { type: 'fixed', value: 500 } });
    expect(CheckoutDraftSchema.safeParse(out).success).toBe(true);
    expect(Number.isInteger(out.tenderedCents)).toBe(true);
  });

  it('converts a fixed discount to cents and back, leaving percent alone', () => {
    expect(discountToDraftValue('fixed', 12.34)).toBe(1234);
    expect(discountFromDraftValue('fixed', 1234)).toBe(12.34);
    expect(discountToDraftValue('percent', 7.5)).toBe(7.5);
  });
});
