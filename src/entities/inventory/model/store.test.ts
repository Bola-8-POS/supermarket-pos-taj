import { beforeEach, describe, expect, it } from 'vitest';
import { useInventoryStore } from './store';
import { InventorySchema } from './types';

const inv = (productId: string, qty: number, threshold: number, name = 'Test') =>
  InventorySchema.parse({
    id: crypto.randomUUID(),
    productId,
    quantityOnHand: qty,
    lowStockThreshold: threshold,
    unit: 'ea',
    product: {
      id: productId,
      name,
      categoryId: crypto.randomUUID(),
      basePrice: 1,
      happyHourPrice: null,
      sku: 'SKU',
      isActive: true,
      imageUrl: null,
      photoPath: null,
      stock_threshold: null,
      unitsPerPackage: null,
      parentProductId: null,
      brandId: null,
      weightAmount: null,
      weightUnit: null,
      modifiers: [],
      category: {
        id: crypto.randomUUID(),
        name: 'Cat',
        color: '#000000',
        sortOrder: 0,
        happyHourStart: null,
        happyHourEnd: null,
        createdAt: new Date(),
      },
    },
  });

describe('useInventoryStore', () => {
  beforeEach(() => {
    useInventoryStore.setState({
      inventory: [],
      lowStockProductIds: [],
      lowStockAlerts: [],
    });
  });

  it('decrementQuantities merges duplicate productIds and clamps at zero', () => {
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    useInventoryStore.getState().setInventory([inv(p1, 5, 10, 'A'), inv(p2, 3, 10, 'B')]);

    useInventoryStore.getState().decrementQuantities([
      { productId: p1, quantity: 2 },
      { productId: p1, quantity: 1 },
      { productId: p2, quantity: 10 },
    ]);

    const { inventory } = useInventoryStore.getState();
    expect(inventory.find(i => i.productId === p1)?.quantityOnHand).toBe(2);
    expect(inventory.find(i => i.productId === p2)?.quantityOnHand).toBe(0);
  });

  it('refreshAlerts builds lowStockAlerts with names', () => {
    const p = crypto.randomUUID();
    useInventoryStore.getState().setInventory([inv(p, 2, 5, 'Heineken')]);

    const { lowStockAlerts, lowStockProductIds } = useInventoryStore.getState();
    expect(lowStockProductIds).toContain(p);
    expect(lowStockAlerts).toEqual([
      expect.objectContaining({ productId: p, name: 'Heineken', quantityOnHand: 2 }),
    ]);
  });
});
