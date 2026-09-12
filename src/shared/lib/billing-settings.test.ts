import { describe, expect, it } from 'vitest';
import { BillingPaymentMethodsSchema, BillingSettingsSchema, PAYMENT_METHODS } from './domain';

describe('BillingPaymentMethodsSchema', () => {
  it('defaults every payment method to enabled', () => {
    const result = BillingPaymentMethodsSchema.parse({});
    for (const method of PAYMENT_METHODS) {
      expect(result[method]).toBe(true);
    }
  });

  it('migrates the legacy bbvaCard key to card, preserving its value', () => {
    const result = BillingPaymentMethodsSchema.parse({
      cash: true,
      bbvaCard: false,
      rappi: true,
    });
    expect(result.card).toBe(false);
    expect(result).not.toHaveProperty('bbvaCard');
  });

  it('prefers card over bbvaCard when both are present', () => {
    const result = BillingPaymentMethodsSchema.parse({
      cash: true,
      bbvaCard: false,
      card: true,
    });
    expect(result.card).toBe(true);
  });

  it('round-trips an explicit uber_eats: false', () => {
    const result = BillingPaymentMethodsSchema.parse({ uber_eats: false });
    expect(result.uber_eats).toBe(false);
  });
});

describe('BillingSettingsSchema taxInclusive', () => {
  it('defaults taxInclusive to true (D-01)', () => {
    const result = BillingSettingsSchema.parse({
      taxRatePercent: 16,
      paymentMethods: { cash: true, card: true, rappi: true },
    });
    expect(result.taxInclusive).toBe(true);
  });

  it('round-trips taxInclusive: false', () => {
    const result = BillingSettingsSchema.parse({
      taxRatePercent: 16,
      paymentMethods: { cash: true, card: true, rappi: true },
      taxInclusive: false,
    });
    expect(result.taxInclusive).toBe(false);
  });

  it('round-trips taxInclusive: true explicitly', () => {
    const result = BillingSettingsSchema.parse({
      taxRatePercent: 16,
      paymentMethods: { cash: true, card: true, rappi: true },
      taxInclusive: true,
    });
    expect(result.taxInclusive).toBe(true);
  });

  it('parses the legacy stored shape (bbvaCard, no firstHourMode) end-to-end', () => {
    const result = BillingSettingsSchema.parse({
      taxRatePercent: 16,
      paymentMethods: { cash: true, bbvaCard: false, rappi: true },
    });
    expect(result.paymentMethods.card).toBe(false);
    expect(result).not.toHaveProperty('firstHourMode');
  });
});
