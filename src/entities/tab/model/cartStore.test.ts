import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CheckoutDraft, Product, Modifier } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
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
    useCartStore.setState({
      items: [],
      heldCart: null,
      comboResult: null,
      pendingIdempotencyKey: null,
      pendingIdempotencyFingerprint: null,
    });
  });

  describe('addItem', () => {
    it("adding a product to a cart that holds a weighed line of it adds a separate line, never raises the weighed line's quantity", () => {
      const { addWeightedItem, addItem } = useCartStore.getState();
      addWeightedItem(mockProduct, 375);
      addItem(mockProduct, []);

      const { items } = useCartStore.getState();
      expect(items).toHaveLength(2);
      expect(items[0]!.quantity).toBe(1);
      expect(items[0]!.weightGrams).toBe(375);
      expect(items[1]!.weightGrams).toBeUndefined();
      // and a second plain add still merges into the plain line, not the weighed one
      addItem(mockProduct, []);
      expect(useCartStore.getState().items.map(i => i.quantity)).toEqual([1, 2]);
    });

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

    // SQL: v_expected_price := ROUND(base_price * (grams / 1000.0), 2) (numeric, half away from zero),
    // and unit_price is checked against it to 0.01. 5.00/kg x 205 g is 1.025 exactly: 1.03, not 1.02.
    it('prices a line like SQL ROUND(price * grams / 1000, 2): exact decimal, ties away from zero', () => {
      expect(calcWeightedLineTotal(5, 205)).toBe(1.03);
      expect(calcWeightedLineTotal(5, 207)).toBe(1.04);
      expect(calcWeightedLineTotal(5, 43)).toBe(0.22);
      expect(calcWeightedLineTotal(0.29, 500)).toBe(0.15);
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

    // SQL prices a loose-weight line first and discounts the line (20260927000002:214-235), so the
    // cart keeps the catalog per-kg price and holds the line total the promotion resolved to.
    it('addWeightedItem with a resolved line total keeps the catalog per-kg price and stores that line total', () => {
      useCartStore.getState().addWeightedItem(mockProduct, 500, 4.5, 'promo-1');

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(mockProduct.basePrice);
      expect(item.lineTotal).toBe(4.5); // not 12 * 0.5kg = 6, and not a per-kg discount times the weight
      expect(item.promotionId).toBe('promo-1');
    });

    it('addWeightedItem without a resolved line total prices at the catalog per-kg price', () => {
      useCartStore.getState().addWeightedItem(mockProduct, 500);

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(mockProduct.basePrice);
      expect(item.lineTotal).toBe(6);
      expect(item.promotionId).toBeUndefined();
    });

    it('updateWeightedItem stores the line total resolved for the new weight', () => {
      const { addWeightedItem, updateWeightedItem } = useCartStore.getState();
      addWeightedItem(mockProduct, 500, 4.5, 'promo-1');
      const tempId = useCartStore.getState().items[0]!.tempId;

      updateWeightedItem(tempId, 1_000, 10, 'promo-1');

      const item = useCartStore.getState().items[0]!;
      expect(item.weightGrams).toBe(1_000);
      expect(item.unitPrice).toBe(mockProduct.basePrice);
      expect(item.lineTotal).toBe(10); // 12 for the kg, a fixed 2 off the line
      expect(item.promotionId).toBe('promo-1');
    });

    it('updateWeightedItem with no resolved line total reprices at the catalog price and drops the promotion', () => {
      const { addWeightedItem, updateWeightedItem } = useCartStore.getState();
      addWeightedItem(mockProduct, 500, 4.5, 'promo-1');
      const tempId = useCartStore.getState().items[0]!.tempId;

      updateWeightedItem(tempId, 1_000);

      const item = useCartStore.getState().items[0]!;
      expect(item.lineTotal).toBe(12);
      expect(item.promotionId).toBeNull();
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

    it('clamps a persisted weighed line with quantity > 1 back to one weighing (items and held cart)', async () => {
      useCartStore.getState().addWeightedItem(mockProduct, 375);
      const weighed = useCartStore.getState().items[0]!;
      const bad = { ...weighed, quantity: 3 };
      window.localStorage.setItem(
        HELD_CART_STORAGE_KEY,
        JSON.stringify({ state: { heldCart: [bad], items: [bad] }, version: 2 })
      );

      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().items).toMatchObject([{ weightGrams: 375, quantity: 1 }]);
      expect(useCartStore.getState().heldCart).toMatchObject([{ weightGrams: 375, quantity: 1 }]);
    });

    it('resumeHeld clamps a weighed line with quantity > 1 to one weighing', () => {
      useCartStore.getState().addWeightedItem(mockProduct, 375);
      const bad = { ...useCartStore.getState().items[0]!, quantity: 3 };
      useCartStore.setState({ items: [], heldCart: [bad] });

      useCartStore.getState().resumeHeld();

      expect(useCartStore.getState().items).toMatchObject([{ weightGrams: 375, quantity: 1 }]);
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

    it('migrates a pre-Task-6 (version 1) payload, preserving items and defaulting the new idempotency fields to null', async () => {
      useCartStore.getState().addItem(mockProduct, []);
      const items = useCartStore.getState().items;

      // Simulate what localStorage held before Task 6 added
      // pendingIdempotencyKey/pendingIdempotencyFingerprint: the same
      // items/heldCart shape, but tagged version 1 and with neither new
      // field present at all.
      window.localStorage.setItem(
        HELD_CART_STORAGE_KEY,
        JSON.stringify({ state: { heldCart: null, items }, version: 1 })
      );

      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().items).toEqual(items);
      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });
  });

  describe('pending idempotency key (offline-first Plan 01, Task 6)', () => {
    function withPendingKey() {
      useCartStore.setState({
        pendingIdempotencyKey: 'direct_sale_1759000000000_abcdef12',
        pendingIdempotencyFingerprint: '{"lines":[],"discount":null}',
      });
    }

    it('clearCart() clears the persisted key and fingerprint', () => {
      withPendingKey();

      useCartStore.getState().clearCart();

      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });

    it('holdCart() clears the persisted key and fingerprint', () => {
      useCartStore.getState().addItem(mockProduct, []);
      withPendingKey();

      useCartStore.getState().holdCart();

      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });

    it('resumeHeld() clears the persisted key and fingerprint', () => {
      const { addItem, holdCart, resumeHeld } = useCartStore.getState();
      addItem(mockProduct, []);
      holdCart();
      withPendingKey();

      resumeHeld();

      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });

    it("discardHeld() does NOT clear the active cart's persisted key (only the held slot is discarded)", () => {
      const { addItem, holdCart, discardHeld } = useCartStore.getState();
      addItem(mockProduct, []);
      holdCart();
      addItem({ ...mockProduct, id: 'active-sale-product' }, []);
      withPendingKey();

      discardHeld();

      expect(useCartStore.getState().pendingIdempotencyKey).toBe(
        'direct_sale_1759000000000_abcdef12'
      );
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBe(
        '{"lines":[],"discount":null}'
      );
    });

    it('setPendingIdempotencyKey() then rehydrate() round-trips the key and fingerprint across a restart', async () => {
      // A pending key only ever exists alongside a non-empty cart in real
      // usage (submit() requires items) — and, since F2 round 2, an empty
      // cart's key/fingerprint is intentionally dropped on rehydrate, so
      // this round-trip must seed an item to stay realistic.
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setPendingIdempotencyKey('direct_sale_123_abc', '{"lines":[]}');

      const persistedEnvelope = window.localStorage.getItem(HELD_CART_STORAGE_KEY);
      useCartStore.setState({ pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null });
      if (persistedEnvelope) {
        window.localStorage.setItem(HELD_CART_STORAGE_KEY, persistedEnvelope);
      }
      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().pendingIdempotencyKey).toBe('direct_sale_123_abc');
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBe('{"lines":[]}');
    });

    it('clearPendingIdempotencyKey() clears both fields', () => {
      withPendingKey();

      useCartStore.getState().clearPendingIdempotencyKey();

      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });

    // opus re-review, F2 round 1, Important: a line-level edit that empties
    // the cart (not just clearCart/holdCart/resumeHeld) must also clear the
    // persisted key — otherwise a restored paid cart emptied one line at a
    // time keeps its stale key, and the next customer's identical cart
    // silently reuses it (same fingerprint), replaying the old sale.
    it('removeItem() clears the persisted key when it empties the cart', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;
      withPendingKey();

      useCartStore.getState().removeItem(tempId);

      expect(useCartStore.getState().items).toHaveLength(0);
      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });

    it('removeItem() does NOT clear the persisted key when another line remains', () => {
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().addItem({ ...mockProduct, id: 'other-product' }, []);
      const tempId = useCartStore.getState().items[0]!.tempId;
      withPendingKey();

      useCartStore.getState().removeItem(tempId);

      expect(useCartStore.getState().items).toHaveLength(1);
      expect(useCartStore.getState().pendingIdempotencyKey).toBe(
        'direct_sale_1759000000000_abcdef12'
      );
    });

    it('updateQuantity() clears the persisted key when the delta takes the last line to zero', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;
      withPendingKey();

      useCartStore.getState().updateQuantity(tempId, -1);

      expect(useCartStore.getState().items).toHaveLength(0);
      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });

    it('setLineQuantity() clears the persisted key when set to 0 on the last line', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const tempId = useCartStore.getState().items[0]!.tempId;
      withPendingKey();

      useCartStore.getState().setLineQuantity(tempId, 0);

      expect(useCartStore.getState().items).toHaveLength(0);
      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });

    it('hydrates to no pending key when only one half of the persisted pair is present (corrupt/partial payload)', async () => {
      window.localStorage.setItem(
        HELD_CART_STORAGE_KEY,
        JSON.stringify({
          state: { heldCart: null, items: [], pendingIdempotencyKey: 'orphan-key' },
          version: 2,
        })
      );

      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
    });

    // opus re-review, F2 round 2, Important: `merge` validates the
    // persisted `items` and the pending key/fingerprint independently. A
    // payload whose items fail CartItemSchema validation (e.g. tampered
    // localStorage, a stale/incompatible shape) rehydrates to an EMPTY cart
    // but, before this fix, kept a perfectly valid-looking key/fingerprint
    // pair — the next customer's identical cart would reproduce that same
    // fingerprint, reuse the stale key, and process_direct_sale_atomic
    // would silently replay the old (already-paid) sale.
    it('drops the persisted key+fingerprint when the persisted items fail validation, even though the pair itself is well-formed', async () => {
      window.localStorage.setItem(
        HELD_CART_STORAGE_KEY,
        JSON.stringify({
          state: {
            heldCart: null,
            items: [{ not: 'a valid cart item' }],
            pendingIdempotencyKey: 'direct_sale_1759000000000_abcdef12',
            pendingIdempotencyFingerprint: '{"lines":[],"discount":null}',
          },
          version: 2,
        })
      );

      await useCartStore.persist.rehydrate();

      expect(useCartStore.getState().items).toEqual([]);
      expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
      expect(useCartStore.getState().pendingIdempotencyFingerprint).toBeNull();
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

    it('resolveConflict on a weighted line stores the fresh line total and keeps the per-kg price', () => {
      useCartStore.getState().addWeightedItem(mockProduct, 500, 4.5, 'promo-1');
      const tempId = useCartStore.getState().items[0]!.tempId;

      useCartStore.getState().resolveConflict(tempId, 5, null);

      const item = useCartStore.getState().items[0]!;
      expect(item.unitPrice).toBe(mockProduct.basePrice);
      expect(item.lineTotal).toBe(5); // the argument is the line total for a weighted line
      expect(item.promotionId).toBeNull();
      expect(item.priceConflict).toBe(false);
    });
  });

  describe('setLineQuantity', () => {
    it('leaves a weighed line untouched (a weighing is never multiplied)', () => {
      useCartStore.getState().addWeightedItem(mockProduct, 375);
      const before = useCartStore.getState().items[0]!;
      useCartStore.getState().setLineQuantity(before.tempId, 5);

      expect(useCartStore.getState().items[0]).toEqual(before);
    });

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
  describe('re-ring marker (two-mode Plan 02b, Task 6b)', () => {
    const marker = {
      saleId: '11111111-1111-4111-8111-111111111111',
      approvedBy: '77777777-7777-4777-8777-777777777777',
      approvalId: '5f1e2d3c-4b5a-4c6d-8e7f-000000000001',
      paidTotal: 9,
    };
    const reset = () =>
      useCartStore.setState({
        items: [],
        heldCart: null,
        comboResult: null,
        pendingIdempotencyKey: null,
        pendingIdempotencyFingerprint: null,
        reRing: null,
      });
    beforeEach(() => {
      window.localStorage.clear();
      reset();
    });

    it('survives cart edits that leave lines in the cart', () => {
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setReRing(marker);

      useCartStore.getState().updateQuantity(useCartStore.getState().items[0]!.tempId, -1);
      useCartStore
        .getState()
        .addItem({ ...mockProduct, id: '223e4567-e89b-12d3-a456-426614174000' }, []);

      expect(useCartStore.getState().reRing).toEqual(marker);
    });

    it.each([
      [
        'clearCart',
        () => {
          useCartStore.getState().clearCart();
        },
      ],
      [
        'removing the last line',
        () => {
          useCartStore.getState().removeItem(useCartStore.getState().items[0]!.tempId);
        },
      ],
      [
        'taking the last line to zero',
        () => {
          useCartStore.getState().updateQuantity(useCartStore.getState().items[0]!.tempId, -1);
        },
      ],
    ])('is cleared by %s', (_name, act) => {
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setReRing(marker);
      act();
      expect(useCartStore.getState().reRing).toBeNull();
    });

    it('a re-ring cart cannot be held', () => {
      const warn = vi.spyOn(logger, 'warn');
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setReRing(marker);
      const before = useCartStore.getState().items;

      useCartStore.getState().holdCart();

      const state = useCartStore.getState();
      expect(state.heldCart).toBeNull();
      expect(state.items).toBe(before);
      expect(state.reRing).toEqual(marker);
      expect(warn).toHaveBeenCalledWith('cart.held.blocked_rering', { saleId: marker.saleId });
      warn.mockRestore();
    });

    it('a held cart cannot be resumed over a re-ring cart', () => {
      const warn = vi.spyOn(logger, 'warn');
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().holdCart();
      useCartStore
        .getState()
        .addItem({ ...mockProduct, id: '223e4567-e89b-12d3-a456-426614174000' }, []);
      useCartStore.getState().setReRing(marker);
      const { items, heldCart } = useCartStore.getState();

      useCartStore.getState().resumeHeld();

      const state = useCartStore.getState();
      expect(state.items).toBe(items);
      expect(state.heldCart).toBe(heldCart);
      expect(state.reRing).toEqual(marker);
      expect(warn).toHaveBeenCalledWith('cart.resume.blocked_rering', { saleId: marker.saleId });
      warn.mockRestore();
    });

    it('clearing a cart that carries a re-ring and a pending key warns with the sale and the key', () => {
      const warn = vi.spyOn(logger, 'warn');
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setReRing(marker);
      useCartStore.getState().setPendingIdempotencyKey('direct_sale_pending_key', 'fp');

      useCartStore.getState().clearCart();

      expect(warn).toHaveBeenCalledWith('cart.rering.cleared_with_pending_key', {
        saleId: marker.saleId,
        pendingIdempotencyKey: 'direct_sale_pending_key',
      });
      expect(useCartStore.getState().reRing).toBeNull();

      // no key minted yet: nothing worth a warning
      warn.mockClear();
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setReRing(marker);
      useCartStore.getState().clearCart();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('a cart with an unreadable re-ring marker is emptied on rehydrate', async () => {
      const warn = vi.spyOn(logger, 'warn');
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setReRing(marker);
      useCartStore.getState().setPendingIdempotencyKey('k', 'fp');
      const envelope = JSON.parse(window.localStorage.getItem(HELD_CART_STORAGE_KEY) ?? '') as {
        state: Record<string, unknown>;
      };
      envelope.state.reRing = { saleId: 'not-a-uuid' };
      useCartStore.setState({ items: [], reRing: null });
      window.localStorage.setItem(HELD_CART_STORAGE_KEY, JSON.stringify(envelope));

      await useCartStore.persist.rehydrate();

      const state = useCartStore.getState();
      expect(state.reRing).toBeNull();
      expect(state.items).toHaveLength(0);
      expect(state.pendingIdempotencyKey).toBeNull();
      expect(warn).toHaveBeenCalledWith('cart.rering.persisted_payload_invalid');
      warn.mockRestore();
    });

    it('is restored with the cart after a restart, and dropped when it is malformed or the cart is empty', async () => {
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setReRing(marker);
      const stored = window.localStorage.getItem(HELD_CART_STORAGE_KEY) ?? '';

      useCartStore.setState({ items: [], reRing: null });
      window.localStorage.setItem(HELD_CART_STORAGE_KEY, stored);
      await useCartStore.persist.rehydrate();
      expect(useCartStore.getState().reRing).toEqual(marker);

      const envelope = JSON.parse(stored) as { state: Record<string, unknown>; version: number };
      for (const state of [
        { ...envelope.state, reRing: { saleId: 'not-a-uuid' } },
        { ...envelope.state, items: [] },
      ]) {
        window.localStorage.setItem(HELD_CART_STORAGE_KEY, JSON.stringify({ ...envelope, state }));
        await useCartStore.persist.rehydrate();
        expect(useCartStore.getState().reRing).toBeNull();
      }
    });

    it('restores a cart saved before the marker existed without one', async () => {
      useCartStore.getState().addItem(mockProduct, []);
      const envelope = JSON.parse(window.localStorage.getItem(HELD_CART_STORAGE_KEY) ?? '') as {
        state: Record<string, unknown>;
      };
      delete envelope.state.reRing;
      window.localStorage.setItem(HELD_CART_STORAGE_KEY, JSON.stringify(envelope));
      await useCartStore.persist.rehydrate();
      expect(useCartStore.getState().reRing).toBeNull();
      expect(useCartStore.getState().items).toHaveLength(1);
    });
  });
  describe('v3 envelope (Phase 30: owner, checkout, submission)', () => {
    const OWNER = '223e4567-e89b-12d3-a456-426614174000';
    const GOOD_KEY = 'direct_sale_1700000000000_abcd1234';

    beforeEach(() => {
      window.localStorage.clear();
    });

    function lineFor(tempId: string, name: string) {
      useCartStore.getState().addItem({ ...mockProduct, id: mockProduct.id, name }, []);
      const line = useCartStore.getState().items.at(-1);
      if (!line) throw new Error('line missing');
      return { ...line, tempId };
    }

    async function hydrate(state: unknown, version = 3): Promise<void> {
      window.localStorage.setItem(HELD_CART_STORAGE_KEY, JSON.stringify({ state, version }));
      await useCartStore.persist.rehydrate();
    }

    const goodDraft: CheckoutDraft = {
      method: 'cash',
      tenderedCents: 5000,
      splitLegs: [{ method: 'card', amountCents: 1000 }],
      discount: { type: 'percent', value: 10 },
      reference: 'ref-1',
    };

    it('migrates a v2 envelope to v3 with owner, checkout and submission null', async () => {
      const line = lineFor('t1', 'A');
      await hydrate({ heldCart: null, items: [line], pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null }, 2);
      const s = useCartStore.getState();
      expect(s.items).toHaveLength(1);
      expect(s.ownerCajaSessionId).toBeNull();
      expect(s.checkout).toBeNull();
      expect(s.submission).toBeNull();
    });

    it('restores equal and touching lines 1:1 without merging', async () => {
      const a = lineFor('t1', 'A');
      const items = [a, { ...a, tempId: 't2' }, { ...a, tempId: 't3', quantity: 2 }];
      await hydrate({ heldCart: null, items, ownerCajaSessionId: OWNER });
      expect(useCartStore.getState().items.map(i => i.tempId)).toEqual(['t1', 't2', 't3']);
    });

    it('keeps persisted line order', async () => {
      const items = [lineFor('z', 'Z'), lineFor('a', 'A'), lineFor('m', 'M')];
      await hydrate({ heldCart: null, items, ownerCajaSessionId: OWNER });
      expect(useCartStore.getState().items.map(i => i.tempId)).toEqual(['z', 'a', 'm']);
    });

    it.each([[[]], [null], [undefined]])('empty, null or absent items (%j) restore an empty cart', async items => {
      await hydrate({
        heldCart: null,
        items,
        ownerCajaSessionId: OWNER,
        checkout: { open: true, draft: goodDraft },
        submission: { key: GOOD_KEY, startedAt: 1 },
      });
      const s = useCartStore.getState();
      expect(s.items).toEqual([]);
      expect(s.ownerCajaSessionId).toBeNull();
      expect(s.checkout).toBeNull();
      expect(s.submission).toBeNull();
    });

    it('a single valid line restores as one line with valid checkout and submission', async () => {
      const line = lineFor('t1', 'A');
      await hydrate({
        heldCart: null,
        items: [line],
        ownerCajaSessionId: OWNER,
        checkout: { open: true, draft: goodDraft },
        submission: { key: GOOD_KEY, startedAt: 1700000000000 },
      });
      const s = useCartStore.getState();
      expect(s.items).toHaveLength(1);
      expect(s.ownerCajaSessionId).toBe(OWNER);
      expect(s.checkout).toEqual({ open: true, draft: goodDraft });
      expect(s.submission).toEqual({ key: GOOD_KEY, startedAt: 1700000000000 });
    });

    it('malformed owner, checkout or submission becomes null while items still restore', async () => {
      const line = lineFor('t1', 'A');
      await hydrate({
        heldCart: null,
        items: [line],
        ownerCajaSessionId: 'not-a-uuid',
        checkout: { open: 'yes', draft: 5 },
        submission: { key: 7 },
      });
      const s = useCartStore.getState();
      expect(s.items).toHaveLength(1);
      expect(s.ownerCajaSessionId).toBeNull();
      expect(s.checkout).toBeNull();
      expect(s.submission).toBeNull();
    });

    it('checkout draft keys outside the allow-list are stripped on restore', async () => {
      const line = lineFor('t1', 'A');
      await hydrate({
        heldCart: null,
        items: [line],
        checkout: {
          open: true,
          draft: {
            ...goodDraft,
            pin: '0000',
            approvalTicket: 'tkt',
            managerOverride: true,
            authorizingManager: { id: 'm' },
          },
        },
      });
      const draft = useCartStore.getState().checkout?.draft;
      expect(draft).toEqual(goodDraft);
      expect(Object.keys(draft ?? {}).sort()).toEqual(Object.keys(goodDraft).sort());
    });

    it.each([
      ['non-integer', 1.5],
      ['negative', -1],
      ['missing', undefined],
    ])('submission with %s startedAt becomes null', async (_name, startedAt) => {
      const line = lineFor('t1', 'A');
      await hydrate({ heldCart: null, items: [line], submission: { key: GOOD_KEY, startedAt } });
      expect(useCartStore.getState().submission).toBeNull();
    });

    it('hydrate never throws on a non-object envelope', async () => {
      for (const state of ['junk', 42, [], null]) {
        await expect(hydrate(state)).resolves.toBeUndefined();
        expect(useCartStore.getState().items).toEqual([]);
        expect(useCartStore.getState().checkout).toBeNull();
      }
    });

    it('clearCart nulls items, key, owner, checkout and submission', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const st = useCartStore.getState();
      st.setPendingIdempotencyKey(GOOD_KEY, 'fp');
      st.setOwnerCajaSessionId(OWNER);
      st.setCheckoutDraft(goodDraft);
      st.setSubmission({ key: GOOD_KEY, startedAt: 1 });
      st.clearCart();
      const s = useCartStore.getState();
      expect(s.items).toEqual([]);
      expect(s.pendingIdempotencyKey).toBeNull();
      expect(s.ownerCajaSessionId).toBeNull();
      expect(s.checkout).toBeNull();
      expect(s.submission).toBeNull();
    });

    it('restoredSnapshotLineIds defaults to [] and persists with the cart', async () => {
      const line = lineFor('t1', 'A');
      await hydrate({ heldCart: null, items: [line], ownerCajaSessionId: OWNER });
      expect(useCartStore.getState().restoredSnapshotLineIds).toEqual([]);
      await hydrate({ heldCart: null, items: [line], ownerCajaSessionId: OWNER, restoredSnapshotLineIds: ['t1'] });
      expect(useCartStore.getState().restoredSnapshotLineIds).toEqual(['t1']);
    });

    it('a malformed restoredSnapshotLineIds fails closed to check every line', async () => {
      const items = [lineFor('t1', 'A'), lineFor('t2', 'B')];
      await hydrate({ heldCart: null, items, ownerCajaSessionId: OWNER, restoredSnapshotLineIds: 'nope' });
      expect(useCartStore.getState().restoredSnapshotLineIds).toEqual(['t1', 't2']);
      await hydrate({ heldCart: null, items, ownerCajaSessionId: OWNER, restoredSnapshotLineIds: [1, null] });
      expect(useCartStore.getState().restoredSnapshotLineIds).toEqual(['t1', 't2']);
    });

    it('clearCart resets restoredSnapshotLineIds; clearCheckout keeps it', () => {
      useCartStore.getState().addItem(mockProduct, []);
      useCartStore.getState().setRestoredSnapshotLineIds(['x']);
      useCartStore.getState().clearCheckout();
      expect(useCartStore.getState().restoredSnapshotLineIds).toEqual(['x']);
      useCartStore.getState().clearCart();
      expect(useCartStore.getState().restoredSnapshotLineIds).toEqual([]);
    });

    it('clearCheckout nulls checkout and keeps items, key and submission', () => {
      useCartStore.getState().addItem(mockProduct, []);
      const st = useCartStore.getState();
      st.setPendingIdempotencyKey(GOOD_KEY, 'fp');
      st.openCheckout();
      st.setSubmission({ key: GOOD_KEY, startedAt: 1 });
      st.clearCheckout();
      const s = useCartStore.getState();
      expect(s.checkout).toBeNull();
      expect(s.items).toHaveLength(1);
      expect(s.pendingIdempotencyKey).toBe(GOOD_KEY);
      expect(s.submission).toEqual({ key: GOOD_KEY, startedAt: 1 });
    });
  });
});
