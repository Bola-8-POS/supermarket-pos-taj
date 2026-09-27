import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CartStoreModule from '@entities/tab/model/cartStore';
import type { Product } from '@shared/lib/domain';
import { useLockStateStore } from '@shared/lib/lock-state-store';
import { renderWithProviders } from '@shared/lib/test-utils';
import { WeightEntryDialog } from './WeightEntryDialog';

const mockAddWeightedItem = vi.fn();
const mockUpdateWeightedItem = vi.fn();

vi.mock('@entities/tab/model/cartStore', async () => {
  const actual = await vi.importActual<typeof CartStoreModule>('@entities/tab/model/cartStore');
  return {
    ...actual,
    useCartStore: (
      selector: (state: {
        addWeightedItem: typeof mockAddWeightedItem;
        updateWeightedItem: typeof mockUpdateWeightedItem;
      }) => unknown
    ) =>
      selector({
        addWeightedItem: mockAddWeightedItem,
        updateWeightedItem: mockUpdateWeightedItem,
      }),
  };
});

const mockProduct: Product = {
  id: 'product-1',
  name: 'Loose Rice',
  categoryId: 'cat-1',
  basePrice: 100,
  happyHourPrice: null,
  sku: null,
  isActive: true,
  soldByWeight: true,
  imageUrl: null,
  photoPath: null,
  stock_threshold: null,
  barcode: '1234567890123',
  unitsPerPackage: null,
  parentProductId: null,
  brandId: null,
  weightAmount: null,
  weightUnit: null,
  comboEligible: true,
  isCombo: false,
  modifiers: [],
};

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

// Types "0.5" via the component's own global-keydown handler, matching the
// component's existing keydown-driven input path (500 grams).
function typeHalfKilo() {
  act(() => {
    pressKey('0');
    pressKey('.');
    pressKey('5');
  });
}

function typeDigits(digits: string) {
  act(() => {
    digits.split('').forEach(pressKey);
  });
}

describe('WeightEntryDialog', () => {
  beforeEach(() => {
    mockAddWeightedItem.mockClear();
    mockUpdateWeightedItem.mockClear();
    useLockStateStore.getState().setLocked(false);
  });

  it('keeps confirmation disabled until a positive weight is entered', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <WeightEntryDialog open onOpenChange={() => {}} product={mockProduct} mode="add" />
    );

    const confirm = screen.getByRole('button', { name: /add to cart/i });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '1' }));
    expect(confirm).toBeEnabled();
  });

  it('mode=add, no onConfirm: calls addWeightedItem, never updateWeightedItem or onConfirm', () => {
    const onOpenChange = vi.fn();
    render(
      <WeightEntryDialog open product={mockProduct} mode="add" onOpenChange={onOpenChange} />
    );

    typeHalfKilo();
    act(() => {
      screen.getByRole('button', { name: /add to cart/i }).click();
    });

    expect(mockAddWeightedItem).toHaveBeenCalledTimes(1);
    expect(mockAddWeightedItem).toHaveBeenCalledWith(mockProduct, 500, undefined, undefined);
    expect(mockUpdateWeightedItem).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('mode=add, no onConfirm, pricePerKgOverride + promotionId set: threads both through to addWeightedItem', () => {
    const onOpenChange = vi.fn();
    render(
      <WeightEntryDialog
        open
        product={mockProduct}
        mode="add"
        onOpenChange={onOpenChange}
        pricePerKgOverride={80}
        promotionId="promo-1"
      />
    );

    typeHalfKilo();
    act(() => {
      screen.getByRole('button', { name: /add to cart/i }).click();
    });

    expect(mockAddWeightedItem).toHaveBeenCalledWith(mockProduct, 500, 80, 'promo-1');
  });

  it('mode=edit + tempId, no onConfirm: calls updateWeightedItem, never addWeightedItem or onConfirm', () => {
    const onOpenChange = vi.fn();
    render(
      <WeightEntryDialog
        open
        product={mockProduct}
        mode="edit"
        tempId="temp-1"
        onOpenChange={onOpenChange}
      />
    );

    typeHalfKilo();
    act(() => {
      screen.getByRole('button', { name: /save weight/i }).click();
    });

    expect(mockUpdateWeightedItem).toHaveBeenCalledTimes(1);
    expect(mockUpdateWeightedItem).toHaveBeenCalledWith('temp-1', 500);
    expect(mockAddWeightedItem).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('onConfirm passed (mode=add): calls onConfirm(weightGrams) exactly once, never addWeightedItem/updateWeightedItem', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <WeightEntryDialog
        open
        product={mockProduct}
        mode="add"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );

    typeHalfKilo();
    act(() => {
      screen.getByRole('button', { name: /add to cart/i }).click();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(500);
    expect(mockAddWeightedItem).not.toHaveBeenCalled();
    expect(mockUpdateWeightedItem).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('onConfirm passed (mode=edit + tempId): still calls onConfirm, never updateWeightedItem/addWeightedItem', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <WeightEntryDialog
        open
        product={mockProduct}
        mode="edit"
        tempId="temp-1"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );

    typeHalfKilo();
    act(() => {
      screen.getByRole('button', { name: /save weight/i }).click();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(500);
    expect(mockAddWeightedItem).not.toHaveBeenCalled();
    expect(mockUpdateWeightedItem).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('invalid weight (0g): confirm is a no-op regardless of onConfirm', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <WeightEntryDialog
        open
        product={mockProduct}
        mode="add"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );

    // No digits typed — weight stays 0g, Confirm button must be disabled.
    const confirmButton = screen.getByRole('button', { name: /add to cart/i });
    expect(confirmButton).toBeDisabled();
    act(() => {
      confirmButton.click();
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(mockAddWeightedItem).not.toHaveBeenCalled();
    expect(mockUpdateWeightedItem).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('invalid weight (50001g): confirm is a no-op regardless of onConfirm', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <WeightEntryDialog
        open
        product={mockProduct}
        mode="add"
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );

    // 50.001 kg = 50001g, exceeds the 50,000g ceiling.
    typeDigits('50.001');
    const confirmButton = screen.getByRole('button', { name: /add to cart/i });
    expect(confirmButton).toBeDisabled();
    act(() => {
      confirmButton.click();
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(mockAddWeightedItem).not.toHaveBeenCalled();
    expect(mockUpdateWeightedItem).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('ignores global keydown digit entry while the terminal is locked (WR-01, same root cause as CR-01)', () => {
    act(() => {
      useLockStateStore.getState().setLocked(true);
    });
    renderWithProviders(
      <WeightEntryDialog open onOpenChange={() => {}} product={mockProduct} mode="add" />
    );

    typeHalfKilo();

    expect(screen.getByRole('button', { name: /add to cart/i })).toBeDisabled();

    act(() => {
      useLockStateStore.getState().setLocked(false);
    });
    typeHalfKilo();

    expect(screen.getByRole('button', { name: /add to cart/i })).toBeEnabled();
  });
});
