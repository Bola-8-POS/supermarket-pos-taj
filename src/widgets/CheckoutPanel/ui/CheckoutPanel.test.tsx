import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCategories } from '@entities/product';
import type * as PromotionModule from '@entities/promotion';
import { useStaffStore } from '@entities/staff/model/store';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { Category, Product, Promotion, Staff } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CheckoutPanel } from './CheckoutPanel';

vi.mock('@entities/product', () => ({
  useProducts: vi.fn(),
  useCategories: vi.fn(),
}));

// Controllable promotions list (Task 5's combo evaluation) — evaluateCombos
// and isProductComboEligible stay the real implementation; only
// usePromotions() is swapped, mirroring PaymentForm.test.tsx's pattern.
const { mockPromotionsData } = vi.hoisted(() => ({
  mockPromotionsData: [] as Promotion[],
}));
vi.mock('@entities/promotion', async importOriginal => {
  const actual = await importOriginal<typeof PromotionModule>();
  return {
    ...actual,
    usePromotions: () => ({ data: mockPromotionsData }),
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock('@features/open-product-peek-window/model/useProductPeekWindow', () => ({
  ensurePeekWindowShown: vi.fn().mockResolvedValue(undefined),
  BARCODE_SCANNED_EVENT: 'barcode-scanned',
  ADD_TO_CART_EVENT: 'add-to-cart',
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: vi.fn(),
}));

const mockProductA: Product = {
  id: 'product-a',
  name: 'Product A',
  categoryId: 'cat-1',
  basePrice: 10,
  happyHourPrice: null,
  sku: null,
  isActive: true,
  soldByWeight: false,
  imageUrl: null,
  photoPath: null,
  stock_threshold: null,
  barcode: '1111111111111',
  unitsPerPackage: null,
  parentProductId: null,
  brandId: null,
  weightAmount: null,
  weightUnit: null,
  comboEligible: true,
  isCombo: false,
  modifiers: [],
};

const mockProductB: Product = {
  ...mockProductA,
  id: 'product-b',
  name: 'Product B',
  barcode: '3333333333333',
};

const mockWeightedProduct: Product = {
  ...mockProductA,
  id: 'product-weighted',
  name: 'Weighted Product',
  soldByWeight: true,
  barcode: '2222222222222',
};

// A stand-in that exposes the same interaction surface the real ProductGrid
// gives a user (a card click calls onSelect / weightEntry.openFor) and
// surfaces the scanned-into search text via a data attribute, without
// needing the full product-list/category-filter tree.
vi.mock('@widgets/ProductGrid/ui/ProductGrid', () => ({
  ProductGrid: ({
    search,
    onSelect,
    weightEntry,
  }: {
    search: string;
    onSelect: (product: Product) => void;
    weightEntry: { openFor: (product: Product) => void };
  }) => (
    <div data-testid="product-grid-mock" data-search={search}>
      <button type="button" onClick={() => { onSelect(mockProductA); }}>
        Mock add product A
      </button>
      <button type="button" onClick={() => { weightEntry.openFor(mockWeightedProduct); }}>
        Mock open weight entry
      </button>
    </div>
  ),
}));

vi.mock('@features/hold-sale/ui/HoldSaleBanner', () => ({
  HoldSaleBanner: () => null,
}));

vi.mock('@features/checkout-sale/model/useCheckoutSale', () => ({
  useCheckoutSale: () => ({
    syntheticTab: {},
    processors: {},
    resetIdempotencyKey: vi.fn(),
  }),
}));

// A lightweight stand-in so the scanner-gate logic under test doesn't need
// the full PaymentForm tree (settings, processors, receipt rendering, etc.).
// Mirrors the '@widgets/PaymentModal' stub pattern already used by
// PaymentPane.test.tsx.
vi.mock('@widgets/PaymentModal/ui/PaymentForm', () => ({
  PaymentForm: ({ onDone, onClose }: { onDone?: () => void; onClose?: () => void }) => (
    <div data-testid="payment-form-mock">
      <button type="button" onClick={onClose}>
        Mock cancel
      </button>
      <button type="button" onClick={onDone}>
        Mock done
      </button>
    </div>
  ),
}));

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

type StoreState = Parameters<Parameters<typeof useStaffStore>[0]>[0];
const mockStoreState =
  (partial: Partial<StoreState>) =>
  (fn: (s: StoreState) => unknown): unknown =>
    fn(partial as StoreState);

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function scanKeys(code: string) {
  code.split('').forEach(pressKey);
  pressKey('Enter');
}

async function scanAndFlush(code: string) {
  await act(async () => {
    scanKeys(code);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const mockStaff: Staff = {
  id: 'staff-1',
  name: 'Test Cashier',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

describe('CheckoutPanel', () => {
  beforeEach(() => {
    useCartStore.setState({ items: [], heldCart: null, comboResult: null });
    vi.mocked(useStaffStore).mockImplementation(mockStoreState({ currentStaff: mockStaff }));
    mockPromotionsData.length = 0;
    // Real useCategories() always returns a defined object — never bare
    // `undefined` — so the default here matches that invariant (only the
    // Task 5 combo describe below overrides `.data` with real fixtures).
    vi.mocked(useCategories).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useCategories>);
  });

  it('populates the search box with the scanned barcode instead of adding to the cart', async () => {
    renderWithProviders(<CheckoutPanel />);

    await scanAndFlush(mockProductA.barcode as string);

    await waitFor(() => {
      expect(screen.getByTestId('product-grid-mock')).toHaveAttribute(
        'data-search',
        mockProductA.barcode
      );
    });
    expect(useCartStore.getState().items).toHaveLength(0);
  });

  it('ignores a scanner burst while payment/receipt UI is active (CHK-01)', async () => {
    renderWithProviders(<CheckoutPanel />);

    await scanAndFlush(mockProductA.barcode as string);
    await act(async () => {
      screen.getByRole('button', { name: /mock add product a/i }).click();
    });
    expect(useCartStore.getState().items).toHaveLength(1);

    await act(async () => {
      screen.getByRole('button', { name: /process payment/i }).click();
    });
    expect(screen.getByTestId('payment-form-mock')).toBeInTheDocument();

    // Scanning is fully disabled (the keydown listener is detached) while
    // payment UI is mounted, so the search box never picks up this scan.
    await scanAndFlush(mockProductB.barcode as string);

    await act(async () => {
      screen.getByRole('button', { name: /mock cancel/i }).click();
    });
    expect(screen.getByTestId('product-grid-mock')).toHaveAttribute(
      'data-search',
      mockProductA.barcode
    );
  });

  it('ignores a scanner burst while the weight-entry dialog is open', async () => {
    renderWithProviders(<CheckoutPanel />);

    await act(async () => {
      screen.getByRole('button', { name: /mock open weight entry/i }).click();
    });
    expect(useCartStore.getState().items).toHaveLength(0);

    // With the weight dialog open, a scan burst must not update the search
    // box or be treated as a second weight-entry trigger.
    await scanAndFlush(mockProductA.barcode as string);
    expect(screen.getByTestId('product-grid-mock')).toHaveAttribute('data-search', '');
  });

  it('restores ordinary scanning once payment is cancelled back to the cart screen', async () => {
    renderWithProviders(<CheckoutPanel />);

    await scanAndFlush(mockProductA.barcode as string);
    await waitFor(() => {
      expect(screen.getByTestId('product-grid-mock')).toHaveAttribute(
        'data-search',
        mockProductA.barcode
      );
    });

    await act(async () => {
      screen.getByRole('button', { name: /mock add product a/i }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: /process payment/i }).click();
    });
    expect(screen.getByTestId('payment-form-mock')).toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: /mock cancel/i }).click();
    });
    expect(screen.queryByTestId('payment-form-mock')).not.toBeInTheDocument();

    await scanAndFlush(mockProductB.barcode as string);
    await waitFor(() => {
      expect(screen.getByTestId('product-grid-mock')).toHaveAttribute(
        'data-search',
        mockProductB.barcode
      );
    });
  });

});

// ---------------------------------------------------------------------------
// Task 5 — live combo evaluation in the cart
// ---------------------------------------------------------------------------

const comboCategoryId = '22222222-2222-2222-2222-222222222222';

const mockComboCategory: Category = {
  id: comboCategoryId,
  name: 'Combo Category',
  color: '#000000',
  sortOrder: 0,
  happyHourStart: null,
  happyHourEnd: null,
  routing: 'NONE',
  parentId: null,
  comboEligible: true,
  createdAt: new Date(),
};

function comboProduct(id: string): Product {
  return {
    ...mockProductA,
    id,
    name: `Combo Item ${id}`,
    barcode: null,
    categoryId: comboCategoryId,
    basePrice: 10,
    comboEligible: true,
  };
}

/** Buy-3-pay-2 combo: one slot of quantity 3 on comboCategoryId, cheapest unit free. */
function makeComboPromotion(): Promotion {
  const now = new Date();
  return {
    id: 'combo-promo-1',
    name: '3x2 Combo',
    targets: [],
    kind: 'combo',
    discountType: 'cheapest_free',
    discountValue: 1,
    startsAt: new Date(now.getTime() - 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000),
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    needsReview: false,
    active: true,
    createdAt: now,
    createdBy: null,
    slots: [
      {
        id: 'slot-1',
        promotionId: 'combo-promo-1',
        position: 0,
        quantity: 3,
        label: null,
        targets: [
          {
            id: 'target-1',
            promotionId: 'combo-promo-1',
            productId: null,
            categoryId: comboCategoryId,
            slotId: 'slot-1',
          },
        ],
      },
    ],
  };
}

describe('CheckoutPanel — combo evaluation (Task 5)', () => {
  beforeEach(() => {
    useCartStore.setState({ items: [], heldCart: null, comboResult: null });
    vi.mocked(useStaffStore).mockImplementation(mockStoreState({ currentStaff: mockStaff }));
    mockPromotionsData.length = 0;
    mockPromotionsData.push(makeComboPromotion());
    vi.mocked(useCategories).mockReturnValue({
      data: [mockComboCategory],
    } as ReturnType<typeof useCategories>);
  });

  it('applies a 3x2 combo across 3 eligible lines: shows the application, the savings row, and the adjusted total', async () => {
    renderWithProviders(<CheckoutPanel />);

    act(() => {
      useCartStore.getState().addItem(comboProduct('combo-a'), []);
      useCartStore.getState().addItem(comboProduct('combo-b'), []);
      useCartStore.getState().addItem(comboProduct('combo-c'), []);
    });

    await waitFor(() => {
      expect(screen.getByTestId('combo-applications')).toBeInTheDocument();
    });
    expect(screen.getByTestId('combo-applications')).toHaveTextContent('3x2 Combo');
    expect(screen.getByTestId('combo-savings')).toHaveTextContent(`−${formatMoney(10)}`);
    // 3 lines x $10 = $30 subtotal, minus $10 combo savings = $20 total.
    expect(screen.getByTestId('cart-total')).toHaveTextContent(formatMoney(20));
  });

  it('shows no combo section when fewer than 3 eligible lines are in the cart', async () => {
    renderWithProviders(<CheckoutPanel />);

    act(() => {
      useCartStore.getState().addItem(comboProduct('combo-a'), []);
      useCartStore.getState().addItem(comboProduct('combo-b'), []);
    });

    await waitFor(() => {
      expect(useCartStore.getState().items).toHaveLength(2);
    });
    expect(screen.queryByTestId('combo-applications')).not.toBeInTheDocument();
    expect(screen.queryByTestId('combo-savings')).not.toBeInTheDocument();
  });
});
