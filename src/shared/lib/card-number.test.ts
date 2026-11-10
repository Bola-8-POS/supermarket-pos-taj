/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { describe, expect, it } from 'vitest';

import { looksLikeCardNumber } from './card-number';

describe('looksLikeCardNumber', () => {
  it('tells a card number from an approval code', () => {
    const cases: Array<[string, boolean]> = [
      // real test numbers (valid Luhn, 13-19 digits), also with spaces and dashes
      ['4111111111111111', true],
      ['4111 1111 1111 1111', true],
      ['4111-1111-1111-1111', true],
      ['  5555 5555 5555 4444  ', true],
      ['378282246310005', true], // 15 digits
      ['4222222222222', true], // 13 digits
      ['6011111111111117', true],
      ['4000000000000000006', true], // 19 digits, valid Luhn
      // a terminal approval code: short, or not a number at all
      ['123456', false],
      ['AUTH-1', false],
      ['A12345', false],
      ['', false],
      ['   ', false],
      // 16 digits that fail the checksum is a code, not a card
      ['4111 1111 1111 1112', false],
      ['1234567890123456', false],
      // outside 13-19 digits, even with a valid checksum
      ['424242424242', false], // 12 digits
      ['79927398713', false], // 11 digits, the classic Luhn example
      ['42424242424242424242', false], // 20 digits
      // letters mixed in: not a card number
      ['4111 1111 1111 111X', false],
      ['REF 4111111111111111', false],
    ];
    for (const [value, expected] of cases) {
      expect(looksLikeCardNumber(value), JSON.stringify(value)).toBe(expected);
    }
  });
});
