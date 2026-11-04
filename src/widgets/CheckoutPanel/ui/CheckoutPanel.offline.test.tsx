/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
/**
 * CheckoutPanel offline and re-ring chrome (two-mode Plan 02b, Task 7b): what the cart screen
 * says while the backend is unreachable and while the cart is a manager's re-ring of a refused
 * offline sale.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOfflineSaleStore } from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useStaffStore } from '@entities/staff/model/store';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CartItem, Product } from '@shared/lib/domain';
import { formatMoney } from '@shared/lib/format';
import { getCurrentLocale } from '@shared/lib/i18n';
import type { ReRingMarker } from '@shared/lib/offline-sale-schema';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CheckoutPanel } from './CheckoutPanel';

const online = vi.hoisted(() => ({ value: true }));
vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOnlineStatus: () => online.value,
}));

const products = vi.hoisted(() => ({ dataUpdatedAt: 0 }));
vi.mock('@entities/product', () => ({
  useProducts: () => ({ data: [], dataUpdatedAt: products.dataUpdatedAt }),
  useCategories: () => ({ data: undefined }),
}));

// stable references: a fresh [] per render would re-run the panel's combo effect forever
const stable = vi.hoisted(() => ({ promotions: [] as unknown[], alerts: [] as unknown[] }));
vi.mock('@entities/promotion', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePromotions: () => ({ data: stable.promotions }),
}));

vi.mock('@entities/inventory', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNearExpiryPricingDates: () => ({ data: stable.alerts, refetch: vi.fn() }),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@features/open-product-peek-window/model/useProductPeekWindow', () => ({
  ensurePeekWindowShown: vi.fn().mockResolvedValue(undefined),
  BARCODE_SCANNED_EVENT: 'barcode-scanned',
  ADD_TO_CART_EVENT: 'add-to-cart',
}));
vi.mock('@widgets/ProductGrid/ui/ProductGrid', () => ({ ProductGrid: () => null }));
vi.mock('@features/hold-sale/ui/HoldSaleBanner', () => ({ HoldSaleBanner: () => null }));
vi.mock('sonner', () => ({ toast: { message: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const hook = vi.hoisted(() => ({
  refusal: null as string | null,
  completionError: null as { code: string; message: string } | null,
}));
vi.mock('@features/checkout-sale/model/useCheckoutSale', () => ({
  useCheckoutSale: () => ({
    syntheticTab: {},
    reRingCompletionError: hook.completionError,
    processors: { offlineRefusal: () => hook.refusal, canSellOffline: () => hook.refusal === null },
  }),
}));

vi.mock('@widgets/PaymentModal/ui/PaymentForm', () => ({
  PaymentForm: ({
    onDone,
    reRing,
  }: {
    onDone?: () => void;
    reRing?: ReRingMarker | null;
  }) => (
    <div data-testid="payment-form-mock" data-rering={reRing?.saleId ?? ''}>
      <button type="button" onClick={onDone}>
        Mock done
      </button>
    </div>
  ),
}));

const PRODUCT: Product = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Basmati rice 1kg',
  categoryId: '66666666-6666-4666-8666-666666666666',
  basePrice: 9,
  happyHourPrice: null,
  sku: null,
  isActive: true,
  soldByWeight: false,
  imageUrl: null,
  photoPath: null,
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
const ITEM: CartItem = {
  tempId: 'temp-1',
  product: PRODUCT,
  quantity: 1,
  selectedModifiers: [],
  unitPrice: 9,
  notes: '',
  lineTotal: 9,
};
const SALE_ID = '11111111-1111-4111-8111-111111111111';
const MARKER: ReRingMarker = {
  saleId: SALE_ID,
  approvedBy: '77777777-7777-4777-8777-777777777777',
  approvalId: 'approval-1',
  paidTotal: 18,
};

beforeEach(() => {
  online.value = true;
  products.dataUpdatedAt = 0;
  hook.refusal = null;
  hook.completionError = null;
  useOfflineSaleStore.setState({ records: [] });
  useCartStore.setState({
    items: [ITEM],
    heldCart: null,
    comboResult: null,
    pendingIdempotencyKey: null,
    pendingIdempotencyFingerprint: null,
    reRing: null,
  });
  useStaffStore.setState({
    currentStaff: {
      id: 'staff-1',
      name: 'Test Cashier',
      role: 'cashier',
      isActive: true,
      mustChangePin: false,
      locale: 'es-MX',
    },
    currentShift: null,
    staffList: [],
    isAuthenticated: true,
  });
});

describe('CheckoutPanel offline', () => {
  it('the offline chip shows when prices were last loaded', () => {
    online.value = false;
    const loadedAt = new Date();
    loadedAt.setHours(15, 45, 0, 0); // earlier or later today: the same calendar day
    products.dataUpdatedAt = loadedAt.getTime();
    renderWithProviders(<CheckoutPanel />);

    const chip = screen.getByTestId('offline-chip');
    expect(chip).toHaveTextContent('Offline');
    const time = new Intl.DateTimeFormat(getCurrentLocale(), {
      hour: 'numeric',
      minute: '2-digit',
    }).format(loadedAt);
    expect(screen.getByTestId('offline-prices-as-of')).toHaveTextContent(`Prices as of ${time}`);
    // today: no date, the catalog is from this morning
    expect(screen.getByTestId('offline-prices-as-of').textContent).not.toContain(
      new Intl.DateTimeFormat(getCurrentLocale(), { day: 'numeric', month: 'short' }).format(loadedAt)
    );

    // a restored catalog can be days old: another day shows the date as well
    cleanup();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(9, 5, 0, 0);
    products.dataUpdatedAt = yesterday.getTime();
    renderWithProviders(<CheckoutPanel />);

    const stamp = new Intl.DateTimeFormat(getCurrentLocale(), {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(yesterday);
    expect(screen.getByTestId('offline-prices-as-of')).toHaveTextContent(`Prices as of ${stamp}`);
  });

  it('the offline chip says so when the catalog has no load time', () => {
    online.value = false;
    renderWithProviders(<CheckoutPanel />);
    expect(screen.getByTestId('offline-prices-as-of')).toHaveTextContent(
      'Prices from the saved catalog'
    );
  });

  it('limit reached shows the blocking message', () => {
    online.value = false;
    hook.refusal = 'limit_count';
    renderWithProviders(<CheckoutPanel />);

    const message = screen.getByTestId('offline-limit-message');
    expect(message).toHaveTextContent(/500 offline sales are waiting/i);
    expect(message).toHaveAttribute('role', 'alert');
    const pay = screen.getByRole('button', { name: /process payment/i });
    expect(pay).toBeDisabled();
    expect(pay).toHaveAccessibleDescription(/500 offline sales are waiting/i);
  });

  it('an age limit says how old the oldest stored sale is', () => {
    online.value = false;
    hook.refusal = 'limit_age';
    renderWithProviders(<CheckoutPanel />);
    expect(screen.getByTestId('offline-limit-message')).toHaveTextContent(/24 hours/i);
  });

  it('offline without a limit leaves payment available', () => {
    online.value = false;
    renderWithProviders(<CheckoutPanel />);
    expect(screen.queryByTestId('offline-limit-message')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /process payment/i })).toBeEnabled();
  });

  it('online checkout shows no offline or re-ring chrome', () => {
    renderWithProviders(<CheckoutPanel />);
    for (const id of ['offline-chip', 'offline-prices-as-of', 'offline-limit-message', 'rering-chip']) {
      expect(screen.queryByTestId(id), id).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /hold/i })).toBeEnabled();
  });
});

describe('CheckoutPanel after a reload', () => {
  const KEY = 'direct_sale_1700000000000_abcd1234';

  it('a cart whose sale is already stored offline is cleared after a reload, with a notice', async () => {
    // what a reload mid-receipt leaves: the record was stored, the cart (and its key) came back
    useOfflineSaleStore.setState({
      records: [makeSale({ id: SALE_ID, receiptNumber: 'P-4F2A91', request: { ...makeSale().request, idempotencyKey: KEY } })],
    });
    useCartStore.setState({ pendingIdempotencyKey: KEY, pendingIdempotencyFingerprint: 'fp' });
    renderWithProviders(<CheckoutPanel />);

    await waitFor(() => {
      expect(useCartStore.getState().items).toHaveLength(0);
    });
    expect(useCartStore.getState().pendingIdempotencyKey).toBeNull();
    expect(screen.getByTestId('stored-sale-notice')).toHaveTextContent('P-4F2A91');
    // the stored record is untouched
    expect(useOfflineSaleStore.getState().records).toHaveLength(1);
  });

  it('a cart with no stored sale is left alone', async () => {
    // a pending key that matches no record (an online attempt in flight), and a cart with no key at all
    useOfflineSaleStore.setState({ records: [makeSale({ id: SALE_ID })] });
    useCartStore.setState({ pendingIdempotencyKey: 'direct_sale_other_key', pendingIdempotencyFingerprint: 'fp' });
    const { unmount } = renderWithProviders(<CheckoutPanel />);
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().pendingIdempotencyKey).toBe('direct_sale_other_key');
    expect(screen.queryByTestId('stored-sale-notice')).not.toBeInTheDocument();
    unmount();

    useCartStore.setState({ pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null });
    renderWithProviders(<CheckoutPanel />);
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(screen.queryByTestId('stored-sale-notice')).not.toBeInTheDocument();
  });

  it('a sale stored while the checkout is open does not clear the cart under the receipt', async () => {
    renderWithProviders(<CheckoutPanel />);
    useCartStore.setState({ pendingIdempotencyKey: KEY, pendingIdempotencyFingerprint: 'fp' });
    useOfflineSaleStore.setState({
      records: [makeSale({ id: SALE_ID, request: { ...makeSale().request, idempotencyKey: KEY } })],
    });
    // the cashier is on the receipt screen: Done clears the cart, nothing before it does
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(screen.queryByTestId('stored-sale-notice')).not.toBeInTheDocument();
  });
});

describe('CheckoutPanel re-ring', () => {
  function seedReRing() {
    useOfflineSaleStore.setState({
      records: [
        makeSale({
          id: SALE_ID,
          status: 'needs_review',
          request: {
            ...makeSale().request,
            method: 'card',
            referenceNumber: 'AUTH-9',
            tenderedAmount: undefined,
          },
        }),
      ],
    });
    useCartStore.setState({ reRing: MARKER });
  }

  it('a re-ring cart shows what the customer paid and cannot be held', async () => {
    const user = userEvent.setup();
    seedReRing();
    renderWithProviders(<CheckoutPanel />);

    const chip = screen.getByTestId('rering-chip');
    expect(chip).toHaveTextContent(`Re-ring of P-111111 — customer paid ${formatMoney(18)}`);
    expect(chip).toHaveTextContent(/Paid by Card.*, reference AUTH-9/i);

    const hold = screen.getByRole('button', { name: /hold/i });
    expect(hold).toBeDisabled();
    expect(hold).toHaveAccessibleDescription(/can't be held/i);
    expect(screen.getByText(/can't be held/i)).toBeVisible();
    await user.click(hold);
    expect(useCartStore.getState().heldCart).toBeNull();
  });

  it('a re-ring cart passes its marker to the payment form', async () => {
    const user = userEvent.setup();
    seedReRing();
    renderWithProviders(<CheckoutPanel />);
    await user.click(screen.getByRole('button', { name: /process payment/i }));
    expect(screen.getByTestId('payment-form-mock')).toHaveAttribute('data-rering', SALE_ID);
  });

  it('clearing a re-ring cart after a payment attempt asks first', async () => {
    const user = userEvent.setup();
    seedReRing();
    useCartStore.setState({
      pendingIdempotencyKey: 'direct_sale_1_abcd',
      pendingIdempotencyFingerprint: 'fp',
    });
    renderWithProviders(<CheckoutPanel />);

    await user.click(screen.getByRole('button', { name: /clear cart/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Clear this re-ring?');
    expect(dialog).toHaveTextContent(/payment for this re-ring may already have gone through/i);
    expect(dialog).toHaveTextContent(/check payments/i);
    expect(useCartStore.getState().items).toHaveLength(1);

    await user.click(within(dialog).getByRole('button', { name: 'Clear anyway' }));
    await waitFor(() => {
      expect(useCartStore.getState().items).toHaveLength(0);
    });
    expect(useCartStore.getState().reRing).toBeNull();
  });

  it('clearing the cart of a completed re-ring does not warn about a double charge', async () => {
    const user = userEvent.setup();
    seedReRing();
    // the payment went through and the record is linked; the cart only survived a reload
    useOfflineSaleStore.setState({
      records: [
        makeSale({
          id: SALE_ID,
          status: 'resolved',
          resolution: 'rering',
          resolvedBy: MARKER.approvedBy,
          linkedTabId: '66666666-6666-4666-8666-666666666666',
        }),
      ],
    });
    useCartStore.setState({
      pendingIdempotencyKey: 'direct_sale_1_abcd',
      pendingIdempotencyFingerprint: 'fp',
    });
    renderWithProviders(<CheckoutPanel />);

    await user.click(screen.getByRole('button', { name: /clear cart/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Clear the cart?');
    expect(dialog).not.toHaveTextContent(/charged twice/i);

    await user.click(within(dialog).getByRole('button', { name: /^clear/i }));
    await waitFor(() => {
      expect(useCartStore.getState().items).toHaveLength(0);
    });
  });

  it('clearing a re-ring cart before any payment attempt uses the ordinary confirmation', async () => {
    const user = userEvent.setup();
    seedReRing();
    renderWithProviders(<CheckoutPanel />);
    await user.click(screen.getByRole('button', { name: /clear cart/i }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Clear the cart?');
  });

  it('a re-ring that could not be linked warns not to re-ring again', async () => {
    const user = userEvent.setup();
    seedReRing();
    hook.completionError = {
      code: 'UNKNOWN_ERROR',
      message: 'The sale was rung up as ABCD1234, but the offline record could not be closed.',
    };
    renderWithProviders(<CheckoutPanel />);
    // the warning belongs to the receipt step, not the cart
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /process payment/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Do not re-ring this sale again');
    expect(dialog).toHaveTextContent('The sale was rung up as ABCD1234');

    // not dismissed by accident
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'I understand' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });
});
