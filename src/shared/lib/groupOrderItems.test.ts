import { describe, it, expect } from 'vitest';
import { groupOrderItems } from './groupOrderItems';
import type { OrderItem } from './groupOrderItems';

function makeItem(overrides: Partial<OrderItem> & { id: string }): OrderItem {
  return {
    id: overrides.id,
    orderId: 'order-1',
    productId: overrides.productId ?? 'prod-1',
    quantity: overrides.quantity ?? 1,
    unitPrice: overrides.unitPrice ?? 10,
    modifierIds: overrides.modifierIds ?? [],
    modifierPriceDelta: overrides.modifierPriceDelta ?? 0,
    notes: overrides.notes ?? null,
    modifiers: overrides.modifiers ?? [],
    product: overrides.product,
    lineTotal: overrides.lineTotal,
    promotionId: overrides.promotionId,
    discountRate: overrides.discountRate,
    discountAmount: overrides.discountAmount,
  };
}

describe('groupOrderItems', () => {
  it('returns empty array for empty input', () => {
    expect(groupOrderItems([])).toEqual([]);
  });

  it('returns single group for a single item', () => {
    const items: OrderItem[] = [
      makeItem({
        id: 'i1',
        productId: 'p1',
        quantity: 1,
        unitPrice: 7,
        product: {
          id: 'p1',
          name: 'Beer',
          categoryId: 'c1',
          basePrice: 7,
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
      }),
    ];
    const result = groupOrderItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.quantity).toBe(1);
    expect(result[0]?.lineTotal).toBe(7);
    expect(result[0]?.productName).toBe('Beer');
  });

  it('merges two items with same product and no modifiers', () => {
    const items: OrderItem[] = [
      makeItem({
        id: 'i1',
        productId: 'p1',
        quantity: 1,
        unitPrice: 7,
        product: {
          id: 'p1',
          name: 'Beer',
          categoryId: 'c1',
          basePrice: 7,
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
      }),
      makeItem({
        id: 'i2',
        productId: 'p1',
        quantity: 2,
        unitPrice: 7,
        product: {
          id: 'p1',
          name: 'Beer',
          categoryId: 'c1',
          basePrice: 7,
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
      }),
    ];
    const result = groupOrderItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.quantity).toBe(3);
    expect(result[0]?.lineTotal).toBe(21);
  });

  it('keeps two groups for same product with different modifiers', () => {
    const items: OrderItem[] = [
      makeItem({
        id: 'i1',
        productId: 'p1',
        quantity: 1,
        unitPrice: 10,
        modifierIds: ['m1'],
        modifierPriceDelta: 1,
      }),
      makeItem({
        id: 'i2',
        productId: 'p1',
        quantity: 1,
        unitPrice: 10,
        modifierIds: ['m2'],
        modifierPriceDelta: 2,
      }),
    ];
    const result = groupOrderItems(items);
    expect(result).toHaveLength(2);
  });

  it('sorts groups alphabetically by productName', () => {
    const items: OrderItem[] = [
      makeItem({
        id: 'i1',
        productId: 'p2',
        quantity: 1,
        unitPrice: 5,
        product: {
          id: 'p2',
          name: 'Whisky',
          categoryId: 'c1',
          basePrice: 5,
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
      }),
      makeItem({
        id: 'i2',
        productId: 'p1',
        quantity: 1,
        unitPrice: 7,
        product: {
          id: 'p1',
          name: 'Beer',
          categoryId: 'c1',
          basePrice: 7,
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
      }),
    ];
    const result = groupOrderItems(items);
    expect(result[0]?.productName).toBe('Beer');
    expect(result[1]?.productName).toBe('Whisky');
  });

  it('treats modifier order as irrelevant (same group)', () => {
    const items: OrderItem[] = [
      makeItem({
        id: 'i1',
        productId: 'p1',
        quantity: 1,
        unitPrice: 10,
        modifierIds: ['m1', 'm2'],
      }),
      makeItem({
        id: 'i2',
        productId: 'p1',
        quantity: 1,
        unitPrice: 10,
        modifierIds: ['m2', 'm1'],
      }),
    ];
    const result = groupOrderItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.quantity).toBe(2);
  });

  it('correctly computes lineTotal with modifierPriceDelta', () => {
    const items: OrderItem[] = [
      makeItem({ id: 'i1', productId: 'p1', quantity: 3, unitPrice: 10, modifierPriceDelta: 0.5 }),
    ];
    const result = groupOrderItems(items);
    expect(result[0]?.lineTotal).toBe(31.5);
  });

  it('falls back to "Menu item" when product is undefined', () => {
    const items: OrderItem[] = [makeItem({ id: 'i1', productId: 'p1', quantity: 1, unitPrice: 5 })];
    const result = groupOrderItems(items);
    expect(result[0]?.productName).toBe('Menu item');
  });

  it('carries a promotion discount snapshot through to the grouped row (PROMO-06)', () => {
    const items: OrderItem[] = [
      makeItem({
        id: 'i1',
        productId: 'p1',
        quantity: 1,
        unitPrice: 9,
        discountRate: 10,
        discountAmount: 1,
      }),
    ];
    const result = groupOrderItems(items);
    expect(result[0]?.discountAmount).toBe(1);
    expect(result[0]?.discountRate).toBe(10);
  });

  it('defaults discountAmount to 0 and discountRate to null when no snapshot present', () => {
    const items: OrderItem[] = [makeItem({ id: 'i1', productId: 'p1', quantity: 1, unitPrice: 5 })];
    const result = groupOrderItems(items);
    expect(result[0]?.discountAmount).toBe(0);
    expect(result[0]?.discountRate).toBeNull();
  });

  it('sums discountAmount across merged lines with the same product/modifiers', () => {
    const items: OrderItem[] = [
      makeItem({ id: 'i1', productId: 'p1', quantity: 1, unitPrice: 9, discountAmount: 1 }),
      makeItem({ id: 'i2', productId: 'p1', quantity: 1, unitPrice: 9, discountAmount: 0.5 }),
    ];
    const result = groupOrderItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.discountAmount).toBe(1.5);
  });
});
