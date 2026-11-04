/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { describe, expect, it } from 'vitest';
import type { CartItem } from '@shared/lib/domain';
import { planRehydrateCorrections } from './rehydrateReconcile';

const line = (over: Partial<CartItem>): CartItem =>
  ({
    tempId: 't1',
    product: { name: 'Milk 1L', basePrice: 3 },
    unitPrice: 2.5,
    lineTotal: 2.5,
    promotionId: 'p1',
    ...over,
  }) as unknown as CartItem;

describe('planRehydrateCorrections', () => {
  it('returns product name and old/new unit price for a repriced line', () => {
    const out = planRehydrateCorrections([line({})], new Set(['t1']), () => null);
    expect(out).toEqual([
      { tempId: 't1', price: 3, promotionId: null, productName: 'Milk 1L', oldPrice: 2.5 },
    ]);
  });

  it('uses line totals for a weighted line', () => {
    const w = line({ weightGrams: 500, unitPrice: 4, lineTotal: 2 });
    const out = planRehydrateCorrections([w], new Set(['t1']), () => null);
    expect(out[0]).toMatchObject({ oldPrice: 2, price: 1.5 });
  });
});
