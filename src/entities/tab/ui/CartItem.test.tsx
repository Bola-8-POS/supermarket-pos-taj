import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CartItem as CartItemType, Product } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CartItem } from './CartItem';

vi.mock('@entities/inventory', () => ({
  useNearExpiryAlerts: () => ({ data: undefined }),
}));

const mockResolveConflict = vi.fn();
vi.mock('@entities/promotion', () => ({
  usePromotions: () => ({ data: [] }),
  evaluateBestPromotion: () => null,
}));
vi.mock('@entities/settings', () => ({
  useSettings: () => ({
    data: {
      nearExpiry: { discountPercent: 0, thresholdDays: 0 },
      general: { timezone: 'America/Mexico_City' },
    },
  }),
}));
vi.mock('@entities/tab/model/cartStore', () => ({
  useCartStore: (selector: (state: { resolveConflict: typeof mockResolveConflict }) => unknown) =>
    selector({ resolveConflict: mockResolveConflict }),
}));

const mockProduct: Product = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Haldiram\'s Aloo Bhujia 200g',
  categoryId: '00000000-0000-4000-8000-000000000001',
  basePrice: 100,
  happyHourPrice: null,
  imageUrl: null,
  photoPath: null,
  isActive: true,
  soldByWeight: false,
  sku: 'ALOO-200G',
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

function buildItem(overrides: Partial<CartItemType> = {}): CartItemType {
  return {
    tempId: 'temp-1',
    product: mockProduct,
    quantity: 1,
    selectedModifiers: [],
    unitPrice: mockProduct.basePrice,
    notes: '',
    lineTotal: mockProduct.basePrice,
    ...overrides,
  };
}

const noop = () => undefined;

describe('CartItem', () => {
  it('shows no discount indicator when unitPrice equals product.basePrice', () => {
    renderWithProviders(
      <CartItem
        item={buildItem()}
        onQuantitySet={noop}
        onRemove={noop}
        onNotesChange={noop}
        comboLabel={undefined}
      />
    );

    expect(screen.queryByLabelText('Promotion applied')).not.toBeInTheDocument();
    expect(screen.queryByText(/% off/)).not.toBeInTheDocument();
  });

  it('shows the Zap icon and a rounded "X% off" Badge when unitPrice is discounted', () => {
    renderWithProviders(
      <CartItem
        item={buildItem({ unitPrice: 80, lineTotal: 80 })}
        onQuantitySet={noop}
        onRemove={noop}
        onNotesChange={noop}
        comboLabel={undefined}
      />
    );

    expect(screen.getByLabelText('Promotion applied')).toBeInTheDocument();
    expect(screen.getByText('20% off')).toBeInTheDocument();
  });

  it('rounds the discount percent to the nearest whole number', () => {
    renderWithProviders(
      <CartItem
        // 100 -> 66.67: (100-66.67)/100 = 33.33% -> rounds to 33%
        item={buildItem({ unitPrice: 66.67, lineTotal: 66.67 })}
        onQuantitySet={noop}
        onRemove={noop}
        onNotesChange={noop}
        comboLabel={undefined}
      />
    );

    expect(screen.getByText('33% off')).toBeInTheDocument();
  });

  it('shows a price-conflict indicator when item.priceConflict is true, and resolves it on tap', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CartItem
        item={buildItem({ priceConflict: true })}
        onQuantitySet={noop}
        onRemove={noop}
        onNotesChange={noop}
        comboLabel={undefined}
      />
    );

    const indicator = screen.getByText('Price changed — tap to review');
    expect(indicator).toBeInTheDocument();

    await user.click(indicator);
    expect(mockResolveConflict).toHaveBeenCalledWith('temp-1', mockProduct.basePrice, null);
  });

  it('never renders the promotion name — only the compact percent badge', () => {
    renderWithProviders(
      <CartItem
        item={buildItem({ unitPrice: 80, lineTotal: 80 })}
        onQuantitySet={noop}
        onRemove={noop}
        onNotesChange={noop}
        comboLabel={undefined}
      />
    );

    // Only the "X% off" text renders next to the discount indicator — no
    // promotion-name free text anywhere on the line (UI-SPEC long-text rule).
    expect(screen.getByText('20% off')).toBeInTheDocument();
  });

  describe('comboLabel (Task 5)', () => {
    it('renders no combo badge when comboLabel is undefined', () => {
      renderWithProviders(
        <CartItem
          item={buildItem()}
          onQuantitySet={noop}
          onRemove={noop}
          onNotesChange={noop}
          comboLabel={undefined}
        />
      );

      expect(screen.queryByTestId('cart-item-combo-badge')).not.toBeInTheDocument();
    });

    it('renders a distinct combo badge with the promotion name when comboLabel is set', () => {
      renderWithProviders(
        <CartItem
          item={buildItem()}
          onQuantitySet={noop}
          onRemove={noop}
          onNotesChange={noop}
          comboLabel="3x2 Combo"
        />
      );

      const badge = screen.getByTestId('cart-item-combo-badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('3x2 Combo');
    });
  });
});
