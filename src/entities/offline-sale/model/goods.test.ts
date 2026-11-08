/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { describe, expect, it } from 'vitest';

import { sameGoods } from './goods';

const RICE = '33333333-3333-4333-8333-333333333333';
const DAL = '44444444-4444-4444-8444-444444444444';
const MOD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const line = (
  productId: string,
  quantity: number,
  extra: { modifierIds?: string[]; weightGrams?: number | null; unitPrice?: number } = {}
) => ({ productId, quantity, modifierIds: extra.modifierIds ?? [], ...extra });

describe('sameGoods', () => {
  it('same goods ignores price and line order and sums merged quantities', () => {
    // identical
    expect(sameGoods([line(RICE, 2)], [line(RICE, 2)])).toBe(true);
    // price is not compared (today's prices differ by design)
    expect(sameGoods([line(RICE, 2, { unitPrice: 5 })], [line(RICE, 2, { unitPrice: 4.5 })])).toBe(true);
    // line order
    expect(sameGoods([line(RICE, 2), line(DAL, 1)], [line(DAL, 1), line(RICE, 2)])).toBe(true);
    // one line of 3 equals two merged lines 1 + 2
    expect(sameGoods([line(RICE, 3)], [line(RICE, 1), line(RICE, 2)])).toBe(true);
    // modifier order does not matter
    expect(
      sameGoods(
        [line(RICE, 1, { modifierIds: [MOD_A, MOD_B] })],
        [line(RICE, 1, { modifierIds: [MOD_B, MOD_A] })]
      )
    ).toBe(true);
    // null and absent weight are the same
    expect(sameGoods([line(RICE, 1, { weightGrams: null })], [line(RICE, 1)])).toBe(true);

    // a different product
    expect(sameGoods([line(RICE, 2)], [line(DAL, 2)])).toBe(false);
    // a different quantity
    expect(sameGoods([line(RICE, 2)], [line(RICE, 3)])).toBe(false);
    // a line removed / added
    expect(sameGoods([line(RICE, 2), line(DAL, 1)], [line(RICE, 2)])).toBe(false);
    expect(sameGoods([line(RICE, 2)], [line(RICE, 2), line(DAL, 1)])).toBe(false);
    // different modifiers
    expect(sameGoods([line(RICE, 1, { modifierIds: [MOD_A] })], [line(RICE, 1)])).toBe(false);
    // different weight
    expect(
      sameGoods([line(RICE, 1, { weightGrams: 500 })], [line(RICE, 1, { weightGrams: 750 })])
    ).toBe(false);
    // both empty
    expect(sameGoods([], [])).toBe(true);
  });
});
