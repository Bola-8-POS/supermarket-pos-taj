/**
 * Widget-seam regression test for opus re-review F2 round 1, Important
 * (Cancel-then-retry double charge, opus-review-task-6.md I-2): renders the
 * REAL CheckoutPanel widget (not a hand-rolled copy of its onClose/onDone
 * wiring) together with the real PaymentForm, real useCheckoutSale, and
 * real cartStore/staffStore/cajaStore — mocking only the network boundary
 * (`callProcessDirectSale`) plus the peripheral infrastructure CheckoutPanel
 * needs to render at all (product/category data, promotions, hold-sale
 * banner, product-grid, printer, settings, permissions). This is the
 * authoritative test for the Cancel fix; the earlier
 * `useCheckoutSale.replaySafety.test.tsx` seam (a small wrapper mirroring
 * CheckoutPanel's wiring by hand) is kept as a lower-level regression check
 * but is not a substitute for exercising the real widget.
 */

import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCajaStore } from '@entities/caja';
import { useCategories } from '@entities/product';
import type * as PromotionModule from '@entities/promotion';
import { useStaffStore } from '@entities/staff/model/store';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CajaSession, CartItem, Product, Shift, Staff } from '@shared/lib/domain';
import type * as EdgeContracts from '@shared/lib/edge-function-contracts';
import type * as PosPrinter from '@shared/lib/pos-printer';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CheckoutPanel } from './CheckoutPanel';

vi.mock('@entities/product', () => ({
  useProducts: vi.fn(),
  useCategories: vi.fn(),
}));

const { mockPromotionsData } = vi.hoisted(() => ({
  mockPromotionsData: [] as unknown[],
}));
vi.mock('@entities/promotion', async importOriginal => {
  const actual = await importOriginal<typeof PromotionModule>();
  return { ...actual, usePromotions: () => ({ data: mockPromotionsData }) };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock('@features/open-product-peek-window/model/useProductPeekWindow', () => ({
  ensurePeekWindowShown: vi.fn().mockResolvedValue(undefined),
  BARCODE_SCANNED_EVENT: 'barcode-scanned',
  ADD_TO_CART_EVENT: 'add-to-cart',
}));

vi.mock('@widgets/ProductGrid/ui/ProductGrid', () => ({
  ProductGrid: () => <div data-testid="product-grid-mock" />,
}));

vi.mock('@features/hold-sale/ui/HoldSaleBanner', () => ({
  HoldSaleBanner: () => null,
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: vi.fn(),
}));

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, ready: true }),
}));

// A stable object reference (not a fresh literal per call) is required: it
// feeds CheckoutPanel.tsx's combo-evaluation useEffect deps array
// (`[items, activePromotions, categoriesById, appSettings, comboTick]`,
// CheckoutPanel.tsx:191) directly. A new literal on every call would make
// that effect re-run and setComboResult() on every render, forever — an
// infinite render loop that only manifests once CheckoutPanel itself (not
// just PaymentForm) is actually rendered.
const mockAppSettings = {
  billing: {
    taxRatePercent: 0,
    taxInclusive: true,
    paymentMethods: { cash: true, card: true, bank_transfer: true, rappi: true, uber_eats: true },
  },
  paymentLabels: undefined,
  general: { timezone: 'America/Mexico_City' },
  nearExpiry: { discountPercent: 0, thresholdDays: 14 },
};
vi.mock('@entities/settings', () => ({
  useSettings: () => ({ data: mockAppSettings }),
  useReceiptSettings: () => ({ data: undefined }),
}));

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return {
    ...actual,
    // Plain literals, not the imported `ok()` helper — vi.mock factories are
    // hoisted above this file's own imports (see useCheckoutSale.replaySafety.test.tsx).
    printReceipt: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
    openCashDrawer: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
  };
});

vi.mock('sonner', () => ({
  toast: { message: vi.fn(), success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const mockCallProcessDirectSale = vi.fn();
// Partial: the offline-sale entity (imported by useCheckoutSale) builds its record
// schema from this module's own request schema, so the real exports must stay.
vi.mock('@shared/lib/edge-function-contracts', async importOriginal => ({
  ...(await importOriginal<typeof EdgeContracts>()),
  callProcessDirectSale: (request: unknown) =>
    (mockCallProcessDirectSale as (r: unknown) => unknown)(request),
}));

type StoreState = Parameters<Parameters<typeof useStaffStore>[0]>[0];
const mockStoreState =
  (partial: Partial<StoreState>) =>
  (fn: (s: StoreState) => unknown): unknown =>
    fn(partial as StoreState);

const staff: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Ana Cashier',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const shift: Shift = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  staffId: staff.id,
  clockIn: new Date(),
  clockOut: null,
  openingCash: 100,
  closingCash: null,
};

const caja: CajaSession = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  terminalId: 'POS-1',
  openedAt: new Date(),
  closedAt: null,
  openedBy: staff.id,
  closedBy: null,
  openingCash: 100,
  closingCash: null,
  notes: null,
  status: 'open',
};

const product: Product = {
  id: 'prod-checkoutpanel-1',
  name: 'Real Widget Test Product',
  categoryId: 'cat-1',
  basePrice: 20,
  happyHourPrice: null,
  imageUrl: null,
  photoPath: null,
  isActive: true,
  soldByWeight: false,
  sku: null,
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

const cartItem: CartItem = {
  tempId: 'temp-checkoutpanel-1',
  product,
  quantity: 1,
  selectedModifiers: [],
  unitPrice: 20,
  notes: '',
  lineTotal: 20,
};

function mockReceipt(receiptNumber: string) {
  return ok({
    paymentId: 'p1',
    receiptData: {
      receiptNumber,
      tabId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      customerName: 'Walk-in',
      cashierName: staff.name,
      storeName: 'Test Store',
      barAddress: '1 Main St',
      items: [],
      subtotal: 20,
      total: 20,
      paymentMethod: 'cash',
      processedAt: new Date(),
      squareReceiptUrl: null,
      tenderedAmount: 20,
      changeAmount: 0,
    },
  });
}

describe('CheckoutPanel replay safety — real widget, Cancel-then-retry (opus re-review F2 round 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromotionsData.length = 0;
    vi.mocked(useCategories).mockReturnValue({ data: undefined } as ReturnType<
      typeof useCategories
    >);
    vi.mocked(useStaffStore).mockImplementation(
      mockStoreState({ currentStaff: staff, currentShift: shift })
    );
    useCartStore.setState({
      items: [cartItem],
      pendingIdempotencyKey: null,
      pendingIdempotencyFingerprint: null,
      heldCart: null,
      comboResult: null,
    });
    useCajaStore.setState({ currentCaja: caja, isCajaOpen: true });
  });

  it('resends the same key on a same-cart retry after Cancel following a lost response (real CheckoutPanel)', async () => {
    const user = userEvent.setup();
    mockCallProcessDirectSale.mockResolvedValueOnce(
      err({ code: 'UNKNOWN_ERROR', message: 'network dropped' })
    );

    renderWithProviders(<CheckoutPanel />);

    await act(async () => {
      screen.getByRole('button', { name: /procesar pago|process payment/i }).click();
    });
    await user.click(screen.getByTestId('quick-tender-exact'));
    await user.click(screen.getByRole('button', { name: 'Process payment' }));
    await waitFor(() => {
      expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(1);
    });
    const firstKey = (mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string })
      .idempotencyKey;

    // Cashier does the natural thing: Cancel (back to the cart screen),
    // then Pay again without touching the cart.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      screen.getByRole('button', { name: /procesar pago|process payment/i }).click();
    });

    mockCallProcessDirectSale.mockResolvedValueOnce(mockReceipt('R777'));
    await user.click(screen.getByTestId('quick-tender-exact'));
    await user.click(screen.getByRole('button', { name: 'Process payment' }));
    await waitFor(() => {
      expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(2);
    });

    const secondKey = (mockCallProcessDirectSale.mock.calls[1]?.[0] as { idempotencyKey: string })
      .idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });
});
