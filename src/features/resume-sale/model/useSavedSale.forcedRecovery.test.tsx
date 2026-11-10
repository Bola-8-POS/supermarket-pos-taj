import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { Product } from '@shared/lib/domain';
import { useSavedSale } from './useSavedSale';

const CAJA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

vi.mock('@entities/caja', () => ({
  useCurrentCaja: () => ({ isSuccess: true, isError: false, resultError: undefined, data: { id: CAJA, status: 'open' } }),
  useCajaStore: (selector: (s: { currentCaja: { id: string; status: string } }) => unknown) =>
    selector({ currentCaja: { id: CAJA, status: 'open' } }),
}));

const product: Product = {
  id: '123e4567-e89b-12d3-a456-426614174000', name: 'Rice', categoryId: '00000000-0000-4000-8000-000000000001',
  basePrice: 20, happyHourPrice: null, imageUrl: null, photoPath: null, isActive: true, soldByWeight: false,
  sku: 'RICE', stock_threshold: null, unitsPerPackage: null, parentProductId: null, brandId: null,
  weightAmount: null, weightUnit: null, comboEligible: false, isCombo: false, modifiers: [],
};

/** 30-review H2: Cancel after an unanswered payment must land on recovery, not on an editable cart. */
describe('useSavedSale forced recovery (30-review H2)', () => {
  beforeEach(() => {
    useCartStore.setState({
      items: [], heldCart: null, checkout: null, submission: null, ownerCajaSessionId: CAJA,
      pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null,
    });
    useCartStore.getState().addItem(product, []);
    useCartStore.getState().setOwnerCajaSessionId(CAJA);
  });

  it('selling with no marker', () => {
    const { result } = renderHook(() => useSavedSale());
    expect(result.current.state).toBe('selling');
  });

  it('a marker with Checkout closed re-enters recovery even after the first gate is done', () => {
    const { result } = renderHook(() => useSavedSale());
    expect(result.current.state).toBe('selling');
    useCartStore.getState().setSubmission({ key: 'direct_sale_k1', startedAt: 1 });
    const again = renderHook(() => useSavedSale());
    expect(again.result.current.state).toBe('recovery');
    expect(result.current.state).toBe('recovery');
  });

  it('a marker with Checkout open (payment in flight) does not leave the payment screen', () => {
    const { result } = renderHook(() => useSavedSale());
    useCartStore.getState().openCheckout();
    useCartStore.getState().setSubmission({ key: 'direct_sale_k1', startedAt: 1 });
    expect(result.current.state).not.toBe('recovery');
  });
});
