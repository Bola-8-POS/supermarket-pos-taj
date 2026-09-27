import { describe, it, expect, beforeEach } from 'vitest';
import type { Product, Modifier } from '@shared/lib/domain';
import { calcWeightedLineTotal, useCartStore } from './cartStore';

/** localStorage key the persist middleware writes the one held-cart slot under. */
const HELD_CART_STORAGE_KEY = 'direct-sale-held-cart';

describe('cartStore', () => {
  const mockProduct: Product = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Margarita',
    // A real UUID, not a placeholder like 'cat-1' — CartItemSchema's
    // ProductSchema.categoryId is UuidSchema-validated, and the held-cart
    // persistence tests below round-trip this fixture through that schema.
    categoryId: '00000000-0000-4000-8000-000000000001',
    basePrice: 12.0,
    happyHourPrice: 9.0,
    imageUrl: null,
    photoPath: null,
    isActive: true,
    soldByWeight: false,
    sku: 'COCKTAIL-MARG',
    stock_threshold: null,
    unitsPerPackage: null,
    parentProductId: null,
    brandId: null,
    weightAmount: null,
    weightUnit: null,
    comboEligible: true,
    isCombo: false,
    modifiers: [],
  };

  const mockModifier: Modifier = {
    id: 'mod-1',
    name: 'Double Shot',
    priceDelta: 3.0,
    sortOrder: 1,
  };

  beforeEach(() => {
    useCartStore.setState({ items: [], heldCart: null, comboResult: null });
  });

  describe('addItem', () => {
    it('should add a new item to the cart', () => {
      useCartStore.getState().addItem(mockProduct, []);

      const { items } = useCartStore.getState();
      expect(items).toHaveLength(1);
      expect(items[0]!.product.id).toBe(mockProduct.id);
      expect(items[0]!.quantity).toBe(1);
      expect(items[0]!.tempId).toBeTruthy();
    });

    it('should increment quantity if same product and modifiers exist', () => {
      const { addItem } = useCartStore.getState();
      addItem(mockProduct, [mockModifier]);
      addItem(mockProduct, [mockModifier]);

      const { items } = useCartStore.getState();
      expect(items).toHaveLength(1);
      expect(items[0]!.quantity).toBe(2);
    });

    it('should add separate item if modifiers differ', () => {
      const { addItem } = useCartStore.getState();
      addItem(mockProduct, []);
      addItem(mockProduct, [mockModifier]);

      expect(useCartStore.getState().items).toHaveLength(2);
    });

    it('should compute lineTotal correctly', () => {
      useCartStore.getState().addItem(mockProduct, [mockModifier]);

      const item = useCartStore.getState().items[0]!;
      expect(item.lineTotal).toBe(15.0); // 12 + 3
    });
  });

  describe('weighted items', () => {
    it('rounds gram-priced lines to the nearest cent, including half-cent ties', () => {
      expect(calcWeightedLineTotal(10, 375)).toBe(3.75);
      expect(calcWeightedLineTotal(1, 5)).toBe(0.01);
    });

    it('keeps same-product weighted entries as independently editable lines', () => {
      const { addWeightedItem, updateWeightedItem } = useCartStore.getState();
      addWeightedItem(mockProduct, 375);
      addWeightedItem(mockProduct, 1_500);

      const [first, second] = useCartStore.getState().items;
      expect(first?.weightGrams).toBe(375);
      expect(second?.weightGrams).toBe(1_500);
      expect(first?.tempId).not.toBe(second?.tempId);
      expect(useCartStore.getState().items).toHaveLength(2);

      updateWeightedItem(first!.tempId, 500);
      expect(useCartStore.getState().items).toMatchObject([
        { weightGrams: 500, lineTotal: 6 },
        { weightGrams: 1_500, lineTotal: 18 },
      ]);
    });

    it('addWeightedItem with pricePerKgOverride stores that per-kg price, not product.basePrice', () => {
      useCartStore.getState().addWeightedItem(mockProduct, 500, 8);

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(8);
      expect(item.lineTotal).toBe(4); // 8 * 0.5kg
    });

    it('addWeightedItem without pricePerKgOverride falls back to product.basePrice', () => {
      useCartStore.getState().addWeightedItem(mockProduct, 500);

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(mockProduct.basePrice);
    });

    it('updateWeightedItem reprices off the line\'s resolved unitPrice, preserving a promotion discount', () => {
      const { addWeightedItem, updateWeightedItem } = useCartStore.getState();
      addWeightedItem(mockProduct, 500, 8); // discounted per-kg price
      const tempId = useCartStore.getState().items[0]!.tempId;

      updateWeightedItem(tempId, 1_000);

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(8);
      expect(item.lineTotal).toBe(8); // 8 * 1kg, not basePrice (12) * 1kg
    });
  });

  describe('removeItem', () => {
    it('should remove item from cart by tempId', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;

      useCartStore.getState().removeItem(tempId);

      expect(useCartStore.getState().items).toHaveLength(0);
    });
  });

  describe('updateQuantity', () => {
    it('should increase quantity', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;

      useCartStore.getState().updateQuantity(tempId, 1);

      expect(useCartStore.getState().items[0]!.quantity).toBe(2);
    });

    it('should decrease quantity', () => {
      const { addItem } = useCartStore.getState();
      addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;
      useCartStore.getState().updateQuantity(tempId, 1);
      useCartStore.getState().updateQuantity(tempId, -1);

      expect(useCartStore.getState().items[0]!.quantity).toBe(1);
    });

    it('should remove item if quantity becomes 0', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;

      useCartStore.getState().updateQuantity(tempId, -1);

      expect(useCartStore.getState().items).toHaveLength(0);
    });

    it('should update lineTotal when quantity changes', () => {
      useCartStore.getState().addItem(mockProduct, [mockModifier]);
      const tempId = useCartStore.getState().items[0]!.tempId;
      useCartStore.getState().updateQuantity(tempId, 1);

      expect(useCartStore.getState().items[0]!.lineTotal).toBe(30.0); // (12+3)*2
    });
  });

  describe('clearCart', () => {
    it('should remove all items', () => {
      const { addItem, clearCart } = useCartStore.getState();
      addItem(mockProduct, []);
      addItem(mockProduct, [mockModifier]);
      clearCart();

      expect(useCartStore.getState().items).toHaveLength(0);
    });
  });

  describe('totalAmount', () => {
    it('should calculate total with no modifiers', () => {
      useCartStore.getState().addItem(mockProduct, []);
      expect(useCartStore.getState().totalAmount()).toBe(12.0);
    });

    it('should calculate total with modifiers', () => {
      useCartStore.getState().addItem(mockProduct, [mockModifier]);
      expect(useCartStore.getState().totalAmount()).toBe(15.0);
    });

    it('should calculate total with multiple quantities', () => {
      useCartStore.getState().addItem(mockProduct, [mockModifier]);
      const tempId = useCartStore.getState().items[0]!.tempId;
      useCartStore.getState().updateQuantity(tempId, 1);

      expect(useCartStore.getState().totalAmount()).toBe(30.0); // (12+3)*2
    });

    it('should calculate total with multiple items', () => {
      const product2: Product = { ...mockProduct, id: 'product-2', basePrice: 8.0 };
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().addItem(product2, []);

      expect(useCartStore.getState().totalAmount()).toBe(20.0);
    });
  });

  describe('itemCount', () => {
    it('should count total items', () => {
      const { addItem } = useCartStore.getState();
      addItem(mockProduct, []);
      addItem(mockProduct, [mockModifier]);

      expect(useCartStore.getState().itemCount()).toBe(2);
    });

    it('should count quantities correctly', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;
      useCartStore.getState().updateQuantity(tempId, 1);
      useCartStore.getState().updateQuantity(tempId, 1);

      expect(useCartStore.getState().itemCount()).toBe(3);
    });
  });

  describe('isCartEmpty', () => {
    it('should return true when cart has no items', () => {
      expect(useCartStore.getState().isCartEmpty()).toBe(true);
    });

    it('should return false when cart has items', () => {
      useCartStore.getState().addItem(mockProduct, []);
      expect(useCartStore.getState().isCartEmpty()).toBe(false);
    });
  });

  describe('held cart', () => {
    it('holds the active cart without blocking a new sale, then resumes it', () => {
      const { addItem, holdCart, resumeHeld } = useCartStore.getState();
      addItem(mockProduct, []);
      const heldItem = useCartStore.getState().items[0];

      holdCart();
      expect(useCartStore.getState()).toMatchObject({ items: [], heldCart: [heldItem] });

      addItem({ ...mockProduct, id: 'new-sale-product' }, []);
      const activeItem = useCartStore.getState().items[0];
      expect(useCartStore.getState().items).toHaveLength(1);
      expect(useCartStore.getState().heldCart).toEqual([heldItem]);

      resumeHeld();
      expect(useCartStore.getState()).toMatchObject({ items: [heldItem], heldCart: [activeItem] });

      resumeHeld();
      expect(useCartStore.getState()).toMatchObject({ items: [activeItem], heldCart: [heldItem] });
    });

    it('clears heldCart when resuming into an empty active cart', () => {
      const { addItem, holdCart, resumeHeld } = useCartStore.getState();
      addItem(mockProduct, []);
      const heldItem = useCartStore.getState().items[0];

      holdCart();
      resumeHeld();

      expect(useCartStore.getState()).toMatchObject({ items: [heldItem], heldCart: null });
    });

    it('discards a held cart without changing the active sale', () => {
      const { addItem, holdCart, discardHeld } = useCartStore.getState();
      addItem(mockProduct, []);
      holdCart();
      addItem({ ...mockProduct, id: 'active-sale-product' }, []);

      discardHeld();
      expect(useCartStore.getState().heldCart).toBeNull();
      expect(useCartStore.getState().items).toHaveLength(1);
    });
  });

  describe('addItem — unitPrice override (Sprint 2)', () => {
    it('addItem with explicit unitPrice stores that price, not product.basePrice', () => {
      useCartStore.getState().addItem(mockProduct, [], 4.5);

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(4.5);
      expect(item.lineTotal).toBe(4.5);
    });

    it('addItem without unitPrice falls back to product.basePrice', () => {
      useCartStore.getState().addItem(mockProduct, []);

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(mockProduct.basePrice);
    });

    it('addItem increments existing item preserving original unitPrice', () => {
      const { addItem } = useCartStore.getState();
      addItem(mockProduct, [], 4.5);
      addItem(mockProduct, [], 4.5);

      const item = useCartStore.getState().items[0]!;
      expect(item.quantity).toBe(2);
      expect(item.lineTotal).toBe(4.5 * 2);
    });
  });

  describe('held cart restart persistence', () => {
    function readPersistedEnvelope(): {
      state: { heldCart: unknown; items: unknown };
      version: number;
    } | null {
      const raw = window.localStorage.getItem(HELD_CART_STORAGE_KEY);
      return raw
        ? (JSON.parse(raw) as { state: { heldCart: unknown; items: unknown }; version: number })
        : null;
    }

    beforeEach(() => {
      window.localStorage.clear();
    });

    it('persists both heldCart and the active items array', () => {
      useCartStore.getState().addItem(mockProduct, []);

      const envelope = readPersistedEnvelope();
      expect(envelope).not.toBeNull();
      expect(envelope!.state.heldCart).toBeNull();
      expect(envelope!.state.items).toHaveLength(1);
    });

    it('rehydrates the active cart across a fresh store hydration (app restart)', async () => {
      useCartStore.getState().addItem(mockProduct, []);
      const activeSnapshot = useCartStore.getState().items;

      const persistedEnvelope = window.localStorage.getItem(HELD_CART_STORAGE_KEY);
      useCartStore.setState({ items: [], heldCart: null });
      if (persistedEnvelope) {
        window.localStorage.setItem(HELD_CART_STORAGE_KEY, persistedEnvelope);
      }
      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().items).toEqual(activeSnapshot);
    });

    it('hydrates to an empty cart when the persisted items payload is missing (pre-upgrade data)', async () => {
      window.localStorage.setItem(
        HELD_CART_STORAGE_KEY,
        JSON.stringify({ state: { heldCart: null }, version: 1 })
      );

      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().items).toEqual([]);
    });

    it('hydrates to an empty cart when the persisted items payload is malformed', async () => {
      window.localStorage.setItem(
        HELD_CART_STORAGE_KEY,
        JSON.stringify({
          state: { heldCart: null, items: [{ not: 'a valid cart item' }] },
          version: 1,
        })
      );

      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().items).toEqual([]);
    });

    it('rehydrates a held weighted-cart snapshot exactly across a fresh store hydration', async () => {
      const { addWeightedItem, setItemNotes, holdCart } = useCartStore.getState();
      addWeightedItem(mockProduct, 375);
      const tempId = useCartStore.getState().items[0]!.tempId;
      setItemNotes(tempId, 'no ice');
      holdCart();
      const heldSnapshot = useCartStore.getState().heldCart;
      expect(heldSnapshot).toMatchObject([
        { weightGrams: 375, unitPrice: mockProduct.basePrice, notes: 'no ice', lineTotal: 4.5 },
      ]);

      // Simulate an app restart: capture what a fresh WebView document would
      // read from disk first, since resetting in-memory state below also
      // re-persists (partialize writes on every setState) and would
      // otherwise overwrite the held slot with the reset value before
      // rehydrate() ever runs.
      const persistedEnvelope = window.localStorage.getItem(HELD_CART_STORAGE_KEY);
      useCartStore.setState({ items: [], heldCart: null });
      if (persistedEnvelope) {
        window.localStorage.setItem(HELD_CART_STORAGE_KEY, persistedEnvelope);
      }
      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().heldCart).toEqual(heldSnapshot);
      expect(useCartStore.getState().items).toEqual([]);
    });

    it('hydrates to no held cart when the persisted payload is missing', async () => {
      window.localStorage.removeItem(HELD_CART_STORAGE_KEY);

      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().heldCart).toBeNull();
    });

    it('hydrates to no held cart when the persisted payload is malformed', async () => {
      window.localStorage.setItem(
        HELD_CART_STORAGE_KEY,
        JSON.stringify({ state: { heldCart: [{ not: 'a valid cart item' }] }, version: 1 })
      );

      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().heldCart).toBeNull();
    });

    it('hydrates to no held cart when the persisted payload is an obsolete version', async () => {
      const { addItem, holdCart } = useCartStore.getState();
      addItem(mockProduct, []);
      holdCart();
      const validHeldCart = useCartStore.getState().heldCart;

      window.localStorage.setItem(
        HELD_CART_STORAGE_KEY,
        JSON.stringify({ state: { heldCart: validHeldCart }, version: 999 })
      );
      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().heldCart).toBeNull();
    });

    it('writes no held slot after resumeHeld()', () => {
      const { addItem, holdCart, resumeHeld } = useCartStore.getState();
      addItem(mockProduct, []);
      holdCart();

      resumeHeld();

      expect(readPersistedEnvelope()!.state.heldCart).toBeNull();
    });

    it('writes no held slot after discardHeld()', () => {
      const { addItem, holdCart, discardHeld } = useCartStore.getState();
      addItem(mockProduct, []);
      holdCart();

      discardHeld();

      expect(readPersistedEnvelope()!.state.heldCart).toBeNull();
    });

    it('holdCart() is a no-op while heldCart is already occupied (D-01 one-slot guard)', () => {
      const { addItem } = useCartStore.getState();
      addItem(mockProduct, []);
      const originalHeldItem = useCartStore.getState().items[0]!;
      addItem({ ...mockProduct, id: 'other-product' }, []);
      const activeItem = useCartStore
        .getState()
        .items.find(item => item.product.id === 'other-product')!;

      // Directly seed both slots — this must be independent of the guarded
      // holdCart() action, since the second call is exactly what's guarded.
      useCartStore.setState({ items: [activeItem], heldCart: [originalHeldItem] });

      useCartStore.getState().holdCart();

      const state = useCartStore.getState();
      expect(state.items).toEqual([activeItem]);
      expect(state.heldCart).toEqual([originalHeldItem]);
    });
  });

  describe('addItem — promotion snapshot (PROMO-08)', () => {
    it('stamps promotionId/discountSnapshotAt only when unitPrice override is supplied', () => {
      useCartStore.getState().addItem(mockProduct, [], 9.6, 'promo-1');

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(9.6);
      expect(item.promotionId).toBe('promo-1');
      expect(item.discountSnapshotAt).toEqual(expect.any(Number));
    });

    it('does not stamp a promotion snapshot when no unitPrice override is passed', () => {
      useCartStore.getState().addItem(mockProduct, []);

      const item = useCartStore.getState().items[0]!;
      expect(item.promotionId).toBeUndefined();
      expect(item.discountSnapshotAt).toBeUndefined();
    });
  });

  describe('flagPriceConflict / resolveConflict (PROMO-08)', () => {
    it('flagPriceConflict sets priceConflict without touching unitPrice/lineTotal', () => {
      useCartStore.getState().addItem(mockProduct, [], 9.6, 'promo-1');
      const tempId = useCartStore.getState().items[0]!.tempId;

      useCartStore.getState().flagPriceConflict(tempId);

      const item = useCartStore.getState().items[0]!;
      expect(item.priceConflict).toBe(true);
      expect(item.unitPrice).toBe(9.6);
    });

    it('resolveConflict applies the fresh price/promotion and clears priceConflict', () => {
      useCartStore.getState().addItem(mockProduct, [], 9.6, 'promo-1');
      const tempId = useCartStore.getState().items[0]!.tempId;
      useCartStore.getState().flagPriceConflict(tempId);

      useCartStore.getState().resolveConflict(tempId, 10.8, 'promo-2');

      const item = useCartStore.getState().items[0]!;
      expect(item.priceConflict).toBe(false);
      expect(item.unitPrice).toBe(10.8);
      expect(item.lineTotal).toBe(10.8);
      expect(item.promotionId).toBe('promo-2');
    });

    it('resolveConflict recomputes a weighted line via calcWeightedLineTotal', () => {
      useCartStore.getState().addWeightedItem(mockProduct, 500, 8, 'promo-1');
      const tempId = useCartStore.getState().items[0]!.tempId;

      useCartStore.getState().resolveConflict(tempId, 10, null);

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(10);
      expect(item.lineTotal).toBe(5); // 10 * 0.5kg
      expect(item.promotionId).toBeNull();
      expect(item.priceConflict).toBe(false);
    });
  });

  describe('setLineQuantity', () => {
    it('should set absolute quantity and lineTotal', () => {
      useCartStore.getState().addItem(mockProduct, [mockModifier]);
      const tempId = useCartStore.getState().items[0]!.tempId;
      useCartStore.getState().setLineQuantity(tempId, 5);

      const item = useCartStore.getState().items[0]!;
      expect(item.quantity).toBe(5);
      expect(item.lineTotal).toBe(75.0); // (12+3)*5
    });

    it('should clamp to max 99', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;
      useCartStore.getState().setLineQuantity(tempId, 500);

      expect(useCartStore.getState().items[0]!.quantity).toBe(99);
    });

    it('should remove line when quantity is 0', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;
      useCartStore.getState().setLineQuantity(tempId, 0);

      expect(useCartStore.getState().items).toHaveLength(0);
    });
  });

  describe('combo evaluation (Task 5)', () => {
    const mockComboResult = {
      applications: [
        {
          promotionId: 'combo-1',
          promotionName: '3x2 Combo',
          discountType: 'percent' as const,
          discountRate: null,
          units: [{ tempId: 'temp-1', discountAmount: 10 }],
          gross: 10,
          net: 10,
        },
      ],
      netSavings: 10,
    };

    it('comboResult defaults to null and comboNetSavings defaults to 0', () => {
      expect(useCartStore.getState().comboResult).toBeNull();
      expect(useCartStore.getState().comboNetSavings()).toBe(0);
    });

    it('setComboResult stores the evaluation and comboNetSavings reflects its netSavings', () => {
      useCartStore.getState().setComboResult(mockComboResult);

      expect(useCartStore.getState().comboResult).toEqual(mockComboResult);
      expect(useCartStore.getState().comboNetSavings()).toBe(10);
    });

    it('clearCart resets comboResult to null', () => {
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setComboResult(mockComboResult);

      useCartStore.getState().clearCart();

      expect(useCartStore.getState().comboResult).toBeNull();
    });

    it('holdCart resets comboResult to null', () => {
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setComboResult(mockComboResult);

      useCartStore.getState().holdCart();

      expect(useCartStore.getState().comboResult).toBeNull();
    });

    it('resumeHeld resets comboResult to null', () => {
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().holdCart();
      useCartStore.getState().addItem({ ...mockProduct, id: 'other-product' }, []);
      useCartStore.getState().setComboResult(mockComboResult);

      useCartStore.getState().resumeHeld();

      expect(useCartStore.getState().comboResult).toBeNull();
    });
  });
});
