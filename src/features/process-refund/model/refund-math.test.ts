import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// Pure refund math invariants (no Supabase, no React)
// These test the client-side validation logic that mirrors process_refund RPC guards.

function canRefund(refundAmount: number, originalAmount: number, alreadyRefunded: number): boolean {
  // Use integer cent arithmetic to avoid floating-point precision issues
  const refundCents = Math.round(refundAmount * 100);
  const originalCents = Math.round(originalAmount * 100);
  const alreadyRefundedCents = Math.round(alreadyRefunded * 100);
  return refundCents > 0 && refundCents <= originalCents - alreadyRefundedCents;
}

describe('refund-math', () => {
  // P10: refund amount must never exceed original (integer arithmetic in cents)
  it('P10: refund amount ≤ original - already_refunded', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }), // originalCents (1¢ to $1000)
        fc.integer({ min: 0, max: 99 }),        // alreadyRefundedPercent (0%..99%)
        (originalCents, alreadyPct) => {
          const alreadyRefundedCents = Math.floor(originalCents * alreadyPct / 100);
          const maxRefundableCents = originalCents - alreadyRefundedCents;
          // Convert to dollar amounts for canRefund
          const original = originalCents / 100;
          const alreadyRefunded = alreadyRefundedCents / 100;
          const maxRefundable = maxRefundableCents / 100;
          if (maxRefundable > 0) {
            // Any positive refund up to maxRefundable should be allowed
            expect(canRefund(maxRefundable, original, alreadyRefunded)).toBe(true);
            // Any refund exceeding maxRefundable by 1 cent should be rejected
            expect(canRefund(maxRefundable + 0.01, original, alreadyRefunded)).toBe(false);
          }
        }
      )
    );
  });

  it('P10: zero refund amount is rejected', () => {
    expect(canRefund(0, 100, 0)).toBe(false);
  });

  it('P10: refund equals exact remaining amount is allowed', () => {
    expect(canRefund(50, 100, 50)).toBe(true);
  });

  it('P10: refund of full original with no prior refunds is allowed', () => {
    expect(canRefund(100, 100, 0)).toBe(true);
  });
});
