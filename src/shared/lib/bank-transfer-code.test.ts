import { describe, expect, it } from 'vitest';

import { generateCode, generateUniqueCode, isValidCode, luhnCheckDigit } from './bank-transfer-code';

describe('bank-transfer-code', () => {
  it('generateCode always returns a 7-digit string accepted by isValidCode', () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateCode();
      expect(code).toMatch(/^\d{7}$/);
      expect(isValidCode(code)).toBe(true);
    }
  });

  it('catches 100% of single-digit transcription errors (Luhn mutation sweep)', () => {
    let caught = 0;
    let total = 0;
    for (let i = 0; i < 500; i++) {
      const code = generateCode();
      for (let pos = 0; pos < 6; pos++) {
        const original = code.charAt(pos);
        for (let wrong = 0; wrong < 10; wrong++) {
          const wrongDigit = String(wrong);
          if (wrongDigit === original) continue;
          const mutated = code.slice(0, pos) + wrongDigit + code.slice(pos + 1);
          total++;
          if (!isValidCode(mutated)) caught++;
        }
      }
    }
    expect(caught).toBe(total);
  });

  it('catches adjacent-digit transposition in >85% of sampled cases, reproducing the known 09<->90 blind spot', () => {
    let caught = 0;
    let total = 0;
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      const pos = Math.floor(Math.random() * 5);
      const a = code.charAt(pos);
      const b = code.charAt(pos + 1);
      if (a === b) continue;
      const swapped = code.slice(0, pos) + b + a + code.slice(pos + 2);
      total++;
      if (!isValidCode(swapped)) caught++;
    }
    const catchRate = caught / total;
    expect(catchRate).toBeGreaterThan(0.85);

    // Known Luhn blind spot: transposing "09" <-> "90" within the payload is
    // NOT caught — documents the real ceiling rather than overclaiming
    // 100% typo-safety (matches the spike's demo() assertion).
    const blindPayload = '090000';
    const blindCode = blindPayload + String(luhnCheckDigit(blindPayload));
    const blindSwapped = '900000' + blindCode.charAt(6);
    expect(isValidCode(blindCode)).toBe(true);
    expect(isValidCode(blindSwapped)).toBe(true);
  });

  it('generateUniqueCode never returns a code already in pendingCodes', () => {
    const pending = new Set([generateCode(), generateCode(), generateCode()]);
    const fresh = generateUniqueCode(pending);
    expect(pending.has(fresh)).toBe(false);
  });
});
