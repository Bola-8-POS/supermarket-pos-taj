import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatMoney, formatMoneyIn, formatPercent, parseMoneyInput } from './format';
import i18n from './i18n/index';

describe('formatMoney', () => {
  beforeEach(async () => {
    // This file's assertions assume es-MX formatting; test-setup.ts defaults
    // the suite to en-US, so opt in explicitly rather than depend on order.
    await i18n.changeLanguage('es-MX');
  });

  afterEach(async () => {
    await i18n.changeLanguage('en-US'); // reset to the test-suite default (see test-setup.ts)
  });

  it('formats a positive amount with the es-MX symbol', () => {
    expect(formatMoney(12.5)).toBe('MX$12.50');
  });

  it('formats a positive amount with the en-US symbol after changeLanguage', async () => {
    await i18n.changeLanguage('en-US');
    expect(formatMoney(12.5)).toBe('$12.50');
  });

  it('leads with a minus sign for negative amounts', () => {
    expect(formatMoney(-3)).toBe('-MX$3.00');
  });

  it('formats zero', () => {
    expect(formatMoney(0)).toBe('MX$0.00');
  });

  it('formats a single-cent amount (ported from the superseded helper)', () => {
    expect(formatMoney(0.01)).toBe('MX$0.01');
  });

  it('groups the numeric portion for large amounts (intentional change from the superseded helper)', () => {
    expect(formatMoney(1234.5)).toBe('MX$1,234.50');
  });

  it('rounds the half-cent boundary up under Intl half-expand rounding (intentional change from the superseded helper)', () => {
    expect(formatMoney(12.555)).toBe('MX$12.56');
  });

  it('prefixes a plus sign for positive amounts when showSign is set', () => {
    expect(formatMoney(12.5, { showSign: true })).toBe('+MX$12.50');
  });

  it('ignores showSign for negative amounts', () => {
    expect(formatMoney(-3, { showSign: true })).toBe(formatMoney(-3));
  });
});

describe('formatMoneyIn', () => {
  afterEach(async () => {
    await i18n.changeLanguage('es-MX'); // reset for other tests/consumers
  });

  it('formats en-US regardless of the live i18n language', () => {
    expect(formatMoneyIn('en-US', 12.5)).toBe('$12.50');
  });

  it('formats es-MX regardless of the live i18n language', () => {
    expect(formatMoneyIn('es-MX', 12.5)).toBe('MX$12.50');
  });

  it('is unaffected by the live language when the live language is es-MX and the explicit locale is en-US', async () => {
    await i18n.changeLanguage('es-MX');
    expect(formatMoneyIn('en-US', 12.5)).toBe('$12.50');
  });
});

describe('formatPercent', () => {
  it('formats with a default of 1 decimal place', () => {
    expect(formatPercent(12.5)).toBe('12.5%');
  });

  it('formats with a custom decimals option', () => {
    expect(formatPercent(12.567, { decimals: 2 })).toBe('12.57%');
  });

  it('formats zero', () => {
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('parseMoneyInput', () => {
  it('parses a well-formed decimal string', () => {
    expect(parseMoneyInput('12.50')).toBe(12.5);
  });

  it('parses a well-formed negative integer string', () => {
    expect(parseMoneyInput('-5')).toBe(-5);
  });

  it('trims surrounding whitespace', () => {
    expect(parseMoneyInput('  12.5  ')).toBe(12.5);
  });

  it.each(['12.5.3', 'abc', '', '   ', '12.5abc', '1e3'])(
    'returns null for malformed input %j',
    (input) => {
      expect(parseMoneyInput(input)).toBeNull();
    }
  );
});
