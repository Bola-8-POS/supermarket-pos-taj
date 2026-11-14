/**
 * Promoted loose-weight lines through the two CheckoutPanel paths no other test reaches: the
 * product-peek window's add-to-cart event and the edit-weight dialog. The server discounts the LINE
 * price of a loose-weight line, so each path must hand the cart the line total resolved for the
 * weight; a dropped weight would put a per-kg figure in as a line total (a wrong charge).
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCategories } from '@entities/product';
import type * as PromotionModule from '@entities/promotion';
import { useStaffStore } from '@entities/staff/model/store';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { Product, Promotion, Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CheckoutPanel } from './CheckoutPanel';

const hoisted = vi.hoisted(() => ({
  promotions: [] as unknown[],
  noDates: [] as unknown[],
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  settings: {
    nearExpiry: { discountPercent: 15, thresholdDays: 14 },
    general: { timezone: 'America/Mexico_City' },
    billing: { taxRatePercent: 0, taxInclusive: true },
  },
}));

// Caja gate has its own tests (CheckoutPanel.restore.test.tsx); here the till is always ready.
vi.mock('@features/resume-sale/model/useSavedSale', () => ({
  useSavedSale: () => ({ state: 'selling' }),
}));

vi.mock('@entities/product', () => ({ useProducts: vi.fn(), useCategories: vi.fn() }));
vi.mock('@entities/promotion', async importOriginal => ({
  ...(await importOriginal<typeof PromotionModule>()),
  usePromotions: () => ({ data: hoisted.promotions, refetch: vi.fn() }),
}));
vi.mock('@entities/settings', () => ({ useSettings: () => ({ data: hoisted.settings }) }));
vi.mock('@entities/inventory', () => ({
  useNearExpiryAlerts: () => ({ data: hoisted.noDates }),
  useNearExpiryPricingDates: () => ({ data: hoisted.noDates, refetch: vi.fn() }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    hoisted.handlers.set(name, handler);
    return Promise.resolve(() => undefined);
  }),
}));
vi.mock('@features/open-product-peek-window/model/useProductPeekWindow', () => ({
  ensurePeekWindowShown: vi.fn().mockResolvedValue(undefined),
  BARCODE_SCANNED_EVENT: 'barcode-scanned',
  ADD_TO_CART_EVENT: 'add-to-cart',
}));
vi.mock('@entities/staff/model/store', () => ({ useStaffStore: vi.fn() }));
vi.mock('@widgets/ProductGrid/ui/ProductGrid', () => ({ ProductGrid: () => null }));
vi.mock('@features/hold-sale/ui/HoldSaleBanner', () => ({ HoldSaleBanner: () => null }));
vi.mock('@features/checkout-sale/model/useCheckoutSale', () => ({
  useCheckoutSale: () => ({ syntheticTab: {}, processors: {}, resetIdempotencyKey: vi.fn() }),
}));
vi.mock('@widgets/PaymentModal/ui/PaymentForm', () => ({ PaymentForm: () => null }));
vi.mock('sonner', () => ({ toast: { message: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const rice: Product = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Loose rice',
  categoryId: '66666666-6666-4666-8666-666666666666',
  basePrice: 20, // per kg
  happyHourPrice: null,
  sku: null,
  isActive: true,
  soldByWeight: true,
  imageUrl: null,
  photoPath: null,
  stock_threshold: null,
  barcode: '2222222222222',
  unitsPerPackage: null,
  parentProductId: null,
  brandId: null,
  weightAmount: null,
  weightUnit: null,
  comboEligible: false,
  isCombo: false,
  modifiers: [],
};

const PROMO_ID = '99999999-9999-4999-8999-999999999999';
function fixedTwoOffRice(): Promotion {
  const now = Date.now();
  return {
    id: PROMO_ID,
    name: '2 off rice',
    targets: [
      {
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        promotionId: PROMO_ID,
        productId: rice.id,
        categoryId: null,
      },
    ],
    kind: 'discount',
    discountType: 'fixed',
    discountValue: 2,
    startsAt: new Date(now - 3_600_000),
    endsAt: new Date(now + 3_600_000),
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    needsReview: false,
    active: true,
    createdAt: new Date(now - 7_200_000),
    createdBy: null,
    slots: [],
  };
}

const staff: Staff = {
  id: 'staff-1',
  name: 'Cashier',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

beforeEach(() => {
  hoisted.handlers.clear();
  hoisted.promotions.length = 0;
  hoisted.promotions.push(fixedTwoOffRice());
  // the peek-window listener only registers inside a Tauri runtime
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  useCartStore.setState({ items: [], heldCart: null, comboResult: null });
  vi.mocked(useStaffStore).mockImplementation(((fn: (s: unknown) => unknown) =>
    fn({ currentStaff: staff })) as never);
  vi.mocked(useCategories).mockReturnValue({ data: undefined } as ReturnType<typeof useCategories>);
});

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('CheckoutPanel — promoted loose-weight lines', () => {
  it('the peek window add-to-cart event prices a promoted weighted product on its LINE', async () => {
    renderWithProviders(<CheckoutPanel />);
    await waitFor(() => {
      expect(hoisted.handlers.has('add-to-cart')).toBe(true);
    });

    act(() => {
      hoisted.handlers.get('add-to-cart')?.({ payload: { product: rice, weightGrams: 500 } });
    });

    // 20/kg x 500 g = 10.00 line, fixed 2.00 PER KG = 1.00 off -> 9.00 (a dropped weight
    // would hand the cart the per-kg 18.00 as a line total)
    const [line] = useCartStore.getState().items;
    expect(line).toMatchObject({
      weightGrams: 500,
      unitPrice: 20,
      lineTotal: 9,
      promotionId: PROMO_ID,
    });
  });

  it('editing the weight of a promoted weighted line keeps the promotion and reprices the line', async () => {
    const user = userEvent.setup();
    useCartStore.getState().addWeightedItem(rice, 500, 8, PROMO_ID);
    renderWithProviders(<CheckoutPanel />);

    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    // the dialog opens on 0.5 kg: clear it and key in 1.5 kg (not 1 kg, where line and per-kg price coincide)
    // one act per key: the dialog's key handler is re-bound after each render
    for (const key of ['Backspace', 'Backspace', 'Backspace', '1', '.', '5']) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    }
    await user.click(screen.getByRole('button', { name: /save weight/i }));

    // 20/kg x 1.5 kg = 30.00 line, fixed 2.00 per kg = 3.00 off -> 27.00, promotion kept (a dropped weight gives 18.00)
    const [line] = useCartStore.getState().items;
    expect(line).toMatchObject({
      weightGrams: 1500,
      unitPrice: 20,
      lineTotal: 27,
      promotionId: PROMO_ID,
    });
  });
});
