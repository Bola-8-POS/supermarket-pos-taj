import { looksLikeCardNumber } from '@shared/lib/card-number';
import {
  CheckoutDraftSchema,
  type CheckoutDraft,
  type DiscountType,
  type PaymentMethod,
} from '@shared/lib/domain';

/** What PaymentForm holds that may survive a restart. Money is already integer cents. */
export interface PaymentDraftInput {
  method: PaymentMethod;
  tenderedCents: number;
  splitLegs: ReadonlyArray<{ method: PaymentMethod; amountCents: number }>;
  discount: { type: DiscountType; value: number } | null;
  reference: string;
}

/**
 * A card-number-shaped reference, or a long run of digits (a PAN typed so far: a 6-digit approval
 * code is the longest digit-only reference worth keeping), is never persisted.
 */
function isUnsafeReference(reference: string): boolean {
  return looksLikeCardNumber(reference) || /^\d{7,}$/.test(reference.replace(/[\s-]/g, ''));
}

/** Form money is decimal currency units; the draft is integer cents. */
export function toCents(amount: number): number {
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0;
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** A fixed discount is money (cents in the draft); a percent stays a percent. */
export function discountToDraftValue(type: DiscountType, value: number): number {
  return type === 'fixed' ? toCents(value) : Math.max(0, Number.isFinite(value) ? value : 0);
}

export function discountFromDraftValue(type: DiscountType, value: number): number {
  return type === 'fixed' ? fromCents(value) : value;
}

/**
 * Allow-list mapper (T-30-02, T-30-22, T-30-23): only the five draft fields leave this function,
 * whatever the caller passes. A card-number-shaped reference is dropped. The result is re-parsed
 * by CheckoutDraftSchema, so it is also what the cart store would accept on read.
 */
export function sanitizeCheckoutDraft(input: PaymentDraftInput): CheckoutDraft {
  const reference = input.reference.trim();
  return CheckoutDraftSchema.parse({
    method: input.method,
    tenderedCents: Math.max(0, Math.trunc(input.tenderedCents)),
    splitLegs: input.splitLegs.map(leg => ({
      method: leg.method,
      amountCents: Math.max(0, Math.trunc(leg.amountCents)),
    })),
    discount: input.discount ? { type: input.discount.type, value: input.discount.value } : null,
    reference: reference === '' || isUnsafeReference(reference) ? null : reference.slice(0, 64),
  });
}
