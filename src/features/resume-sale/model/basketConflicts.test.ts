import { describe, expect, it } from 'vitest';
import type { CartItem } from '@shared/lib/domain';
import { findBasketConflicts, type CurrentValues } from './basketConflicts';

const PRODUCT_ID = 'ffffffff-ffff-ffff-ffff-fffffffffff1';
const PROMO_A = '99999999-9999-9999-9999-999999999991';
const PROMO_B = '99999999-9999-9999-9999-999999999992';

const line = (over: Partial<CartItem> = {}): CartItem => ({
  tempId: 'line-1',
  product: {
    id: PRODUCT_ID,
    name: 'Basmati Rice',
    categoryId: '11111111-1111-1111-1111-111111111111',
    basePrice: 12.5,
    happyHourPrice: null,
    sku: null,
    isActive: true,
    soldByWeight: false,
    imageUrl: null,
    photoPath: null,
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
    comboEligible: true,
    isCombo: false,
    modifiers: [],
  },
  quantity: 2,
  selectedModifiers: [],
  unitPrice: 12.5,
  notes: '',
  lineTotal: 25,
  promotionId: null,
  ...over,
});

const same: CurrentValues = { priceCents: 1250, promotionId: null, stock: null };
const current = (over: Partial<CurrentValues> = {}, id = 'line-1') =>
  new Map<string, CurrentValues>([[id, { ...same, ...over }]]);

describe('findBasketConflicts (D-03)', () => {
  it('unchanged price, promotion and stock give no conflicts', () => {
    expect(findBasketConflicts([line()], current({ stock: 10 }))).toEqual([]);
  });

  it('a price raised since the save is a price conflict with saved and current cents', () => {
    const [c, ...rest] = findBasketConflicts([line()], current({ priceCents: 1350 }));
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ kind: 'price', lineId: 'line-1', productName: 'Basmati Rice', saved: 1250, current: 1350 });
  });

  it('a price lowered since the save is a price conflict', () => {
    const result = findBasketConflicts([line()], current({ priceCents: 1000 }));
    expect(result.map(c => c.kind)).toEqual(['price']);
    expect(result[0]).toMatchObject({ saved: 1250, current: 1000 });
  });

  it('a 1-cent difference is a conflict, in both directions; integer cents, no tolerance', () => {
    expect(findBasketConflicts([line()], current({ priceCents: 1251 })).map(c => c.kind)).toEqual(['price']);
    expect(findBasketConflicts([line()], current({ priceCents: 1249 })).map(c => c.kind)).toEqual(['price']);
  });

  it('a promotion that ended, started or changed is a promotion conflict', () => {
    const ended = findBasketConflicts([line({ promotionId: PROMO_A })], current());
    expect(ended.map(c => c.kind)).toContain('promotion');
    const started = findBasketConflicts([line()], current({ promotionId: PROMO_A }));
    expect(started.map(c => c.kind)).toContain('promotion');
    const changed = findBasketConflicts([line({ promotionId: PROMO_A })], current({ promotionId: PROMO_B }));
    expect(changed.map(c => c.kind)).toContain('promotion');
    expect(findBasketConflicts([line({ promotionId: PROMO_A })], current({ promotionId: PROMO_A }))).toEqual([]);
  });

  it('current stock below the saved quantity is a stock conflict; untracked stock gives none', () => {
    const low = findBasketConflicts([line({ quantity: 3 })], current({ stock: 2 }));
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ kind: 'stock', saved: 3, current: 2 });
    expect(findBasketConflicts([line({ quantity: 3 })], current({ stock: 3 }))).toEqual([]);
    expect(findBasketConflicts([line({ quantity: 3 })], current({ stock: null }))).toEqual([]);
  });

  it('unreadable current values make every restored line an unavailable conflict', () => {
    const items = [line(), line({ tempId: 'line-2' })];
    for (const unreadable of [null, new Map<string, CurrentValues>()]) {
      const result = findBasketConflicts(items, unreadable);
      expect(result.map(c => [c.lineId, c.kind, c.current])).toEqual([
        ['line-1', 'unavailable', null],
        ['line-2', 'unavailable', null],
      ]);
    }
  });

  it('a weighed line compares its saved line total, not its per-kg price', () => {
    const weighed = line({ weightGrams: 500, unitPrice: 20, lineTotal: 10 });
    expect(findBasketConflicts([weighed], current({ priceCents: 1000 }))).toEqual([]);
    expect(findBasketConflicts([weighed], current({ priceCents: 1001 })).map(c => c.kind)).toEqual(['price']);
  });

  it('conflict keys change with the current value, so an acceptance cannot outlive it', () => {
    const a = findBasketConflicts([line()], current({ priceCents: 1350 }))[0];
    const b = findBasketConflicts([line()], current({ priceCents: 1360 }))[0];
    expect(a?.key).not.toBe(b?.key);
  });

  it('findBasketConflicts leaves the input lines deep-equal', () => {
    const items = [line({ promotionId: PROMO_A }), line({ tempId: 'line-2', quantity: 5 })];
    const snapshot = structuredClone(items);
    findBasketConflicts(items, new Map([['line-1', { priceCents: 1, promotionId: null, stock: 0 }]]));
    expect(items).toEqual(snapshot);
  });
});
