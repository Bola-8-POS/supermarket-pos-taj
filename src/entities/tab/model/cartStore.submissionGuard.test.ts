import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@shared/lib/domain';
import { useCartStore } from './cartStore';

const product: Product = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Rice',
  categoryId: '00000000-0000-4000-8000-000000000001',
  basePrice: 20,
  happyHourPrice: null,
  imageUrl: null,
  photoPath: null,
  isActive: true,
  soldByWeight: false,
  sku: 'RICE',
  stock_threshold: null,
  unitsPerPackage: null,
  parentProductId: null,
  brandId: null,
  weightAmount: null,
  weightUnit: null,
  comboEligible: false,
  isCombo: false,
  modifiers: [],
};

/** Review M1/H2: a cart under an unresolved submission marker must not be emptied, parked or swapped. */
describe('cartStore submission marker guard (30-review M1/H2)', () => {
  beforeEach(() => {
    useCartStore.setState({
      items: [],
      heldCart: null,
      comboResult: null,
      pendingIdempotencyKey: null,
      pendingIdempotencyFingerprint: null,
      submission: null,
    });
    useCartStore.getState().addItem(product, []);
    useCartStore.getState().setSubmission({ key: 'direct_sale_k1', startedAt: 1 });
  });

  it('holdCart is refused while a marker exists: items and marker stay', () => {
    useCartStore.getState().holdCart();
    const s = useCartStore.getState();
    expect(s.items).toHaveLength(1);
    expect(s.heldCart).toBeNull();
    expect(s.submission?.key).toBe('direct_sale_k1');
  });

  it('removing the last line is refused while a marker exists', () => {
    const tempId = useCartStore.getState().items[0]!.tempId;
    useCartStore.getState().removeItem(tempId);
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().submission).not.toBeNull();
  });

  it('decrementing the last unit to zero is refused while a marker exists', () => {
    const tempId = useCartStore.getState().items[0]!.tempId;
    useCartStore.getState().updateQuantity(tempId, -1);
    expect(useCartStore.getState().items).toHaveLength(1);
  });

  it('setLineQuantity(0) on the last line is refused while a marker exists', () => {
    const tempId = useCartStore.getState().items[0]!.tempId;
    useCartStore.getState().setLineQuantity(tempId, 0);
    expect(useCartStore.getState().items).toHaveLength(1);
  });

  it('with no marker the same actions still work', () => {
    useCartStore.getState().clearSubmission();
    useCartStore.getState().holdCart();
    expect(useCartStore.getState().items).toHaveLength(0);
    expect(useCartStore.getState().heldCart).toHaveLength(1);
  });
});
