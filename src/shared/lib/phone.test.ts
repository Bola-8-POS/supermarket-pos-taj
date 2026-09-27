import { describe, expect, it } from 'vitest';

import { isE164, toE164 } from './phone';

describe('toE164', () => {
  it('passes through a valid E.164 MX number unchanged', () => {
    expect(toE164('+525512345678')).toBe('+525512345678');
  });

  it('converts a bare MX number with spaces to E.164', () => {
    expect(toE164('55 1234 5678')).toBe('+525512345678');
  });

  it('converts a bare MX number without spaces to E.164', () => {
    expect(toE164('5512345678')).toBe('+525512345678');
  });

  it('converts a US number with country code to E.164', () => {
    expect(toE164('+1 650 253 0000')).toBe('+16502530000');
  });

  it('returns null for a non-phone string', () => {
    expect(toE164('not a phone')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(toE164('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(toE164('   ')).toBeNull();
  });

  it('returns null for a partial number too short to be valid', () => {
    expect(toE164('1234')).toBeNull();
  });
});

describe('isE164', () => {
  it('returns true for a valid E.164 MX number', () => {
    expect(isE164('+525512345678')).toBe(true);
  });

  it('returns false for a bare number without country code', () => {
    expect(isE164('5512345678')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isE164('')).toBe(false);
  });
});
