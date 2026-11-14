import { describe, expect, it } from 'vitest';
import { CreatePaymentSchema, PaymentSchema } from './types';

const validPayment = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  amount: 12.5,
  method: 'cash' as const,
  squarePaymentId: null,
  squareReceiptUrl: null,
  tenderedAmount: 20,
  processedAt: new Date(),
  processedBy: '11111111-1111-4111-8111-111111111111',
};

describe('PaymentSchema', () => {
  it('parses valid payment', () => {
    const r = PaymentSchema.safeParse(validPayment);
    expect(r.success).toBe(true);
  });

  it('rejects invalid id', () => {
    const r = PaymentSchema.safeParse({ ...validPayment, id: 'not-uuid' });
    expect(r.success).toBe(false);
  });

  it('accepts negative amount (refund rows store a negative amount)', () => {
    const r = PaymentSchema.safeParse({ ...validPayment, amount: -1, isRefund: true });
    expect(r.success).toBe(true);
  });

  it('rejects invalid squareReceiptUrl when non-null', () => {
    const r = PaymentSchema.safeParse({
      ...validPayment,
      squareReceiptUrl: 'not-a-url',
    });
    expect(r.success).toBe(false);
  });

  // Regression guard (Phase 24 Plan 03, Rule 1): method previously hand-rolled
  // z.enum(['cash','card','rappi']), missing 'bank_transfer' — any bank_transfer
  // row among the most recent 100 payments threw inside usePayments()'s .map(),
  // silently blanking the whole /payments page. method now reuses domain.ts's
  // PaymentMethodSchema as the single source of truth (CLAUDE.md).
  it('accepts bank_transfer method', () => {
    const r = PaymentSchema.safeParse({ ...validPayment, method: 'bank_transfer' });
    expect(r.success).toBe(true);
  });
});

describe('CreatePaymentSchema', () => {
  it('omits id and processedAt', () => {
    const r = CreatePaymentSchema.safeParse({
      tabId: validPayment.tabId,
      amount: 1,
      method: 'rappi',
      squarePaymentId: null,
      squareReceiptUrl: null,
      processedBy: validPayment.processedBy,
    });
    expect(r.success).toBe(true);
  });
});
