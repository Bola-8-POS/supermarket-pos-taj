import { renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBMISSION_SETTLE_MS } from '@features/resume-sale/model/submissionRecovery';
import { useSavedSale } from '@features/resume-sale/model/useSavedSale';
import { useCategories } from '@entities/product';
import type * as PromotionModule from '@entities/promotion';
import { useStaffStore } from '@entities/staff/model/store';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CheckoutDraft, Product, Staff } from '@shared/lib/domain';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CheckoutPanel } from './CheckoutPanel';

const CAJA_A = '123e4567-e89b-12d3-a456-426614174001';
const CAJA_B = '123e4567-e89b-12d3-a456-426614174002';

type CajaMock = { id: string; status: 'open' | 'closed' };
type QueryMock = {
  isSuccess: boolean;
  isError: boolean;
  data: CajaMock | null | undefined;
  resultError: unknown;
};
const { cajaQuery, cachedCaja, catalog, lookup, fetchReceipt, checkoutProcessors } = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetchReceipt: vi.fn(),
  checkoutProcessors: { processCashPayment: vi.fn(), processCardPayment: vi.fn(), processSplitPayment: vi.fn() },
  cajaQuery: { value: {} as QueryMock },
  cachedCaja: { value: null as CajaMock | null },
  // current catalog values the restored-sale review compares against (D-03)
  catalog: {
    products: [] as unknown[] | undefined,
    inventory: [] as unknown[],
    dates: [] as unknown[],
  },
}));

vi.mock('@entities/caja', () => ({
  useCurrentCaja: () => cajaQuery.value,
  useCajaStore: (selector: (s: { currentCaja: unknown }) => unknown) =>
    selector({ currentCaja: cachedCaja.value }),
}));
vi.mock('@entities/payment', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findPaymentByIdempotencyKey: lookup,
  fetchReceiptDataForPayment: fetchReceipt,
}));
vi.mock('@entities/product', () => ({
  useProducts: () => ({ data: catalog.products }),
  useCategories: vi.fn(),
}));
vi.mock('@entities/inventory', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useInventory: () => ({ data: catalog.inventory }),
  useNearExpiryPricingDates: () => ({ data: catalog.dates, refetch: vi.fn() }),
}));
// stable reference: a fresh settings object per render would re-trigger the panel's combo effect
const stableSettings = vi.hoisted(() => ({
  data: {
    nearExpiry: { discountPercent: 15, thresholdDays: 14 },
    general: { timezone: 'America/Mexico_City' },
    billing: { taxRatePercent: 0, taxInclusive: true },
  },
}));
vi.mock('@entities/settings', () => ({ useSettings: () => stableSettings }));
// Stable reference: a fresh [] per render would re-trigger the panel's promotion effects.
const stablePromotions = vi.hoisted(() => ({ data: [] as never[] }));

vi.mock('@entities/promotion', async importOriginal => {
  const actual = await importOriginal<typeof PromotionModule>();
  return { ...actual, usePromotions: () => stablePromotions };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@features/open-product-peek-window/model/useProductPeekWindow', () => ({
  ensurePeekWindowShown: vi.fn().mockResolvedValue(undefined),
  BARCODE_SCANNED_EVENT: 'barcode-scanned',
  ADD_TO_CART_EVENT: 'add-to-cart',
}));
vi.mock('@entities/staff/model/store', () => ({ useStaffStore: vi.fn() }));
vi.mock('@widgets/ProductGrid/ui/ProductGrid', () => ({
  ProductGrid: () => <div data-testid="product-grid-mock" />,
}));
vi.mock('@features/hold-sale/ui/HoldSaleBanner', () => ({ HoldSaleBanner: () => null }));
vi.mock('@features/checkout-sale/model/useCheckoutSale', () => ({
  useCheckoutSale: () => ({ syntheticTab: {}, processors: checkoutProcessors, resetIdempotencyKey: vi.fn() }),
}));
vi.mock('@widgets/PaymentModal/ui/PaymentForm', () => ({
  PaymentForm: (props: {
    initialDraft?: { tenderedCents: number };
    initialReceipt?: { receiptNumber: string };
    payBlockedReason?: string | undefined;
    onClose?: () => void;
    onDone?: () => void;
  }) => (
    <div
      data-testid="payment-form"
      data-tendered={String(props.initialDraft?.tenderedCents ?? 'none')}
      data-blocked={props.payBlockedReason ?? ''}
      data-receipt={props.initialReceipt?.receiptNumber ?? ''}
    >
      <button type="button" onClick={props.onClose}>
        mock-cancel
      </button>
      <button type="button" onClick={props.onDone}>
        mock-done
      </button>
    </div>
  ),
}));
vi.mock('sonner', () => ({ toast: { message: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const product: Product = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Product A',
  categoryId: '123e4567-e89b-12d3-a456-426614174099',
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
const staff: Staff = {
  id: 'staff-1',
  name: 'Test Cashier',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const pending = (): QueryMock => ({
  isSuccess: false,
  isError: false,
  data: undefined,
  resultError: undefined,
});
const errored = (): QueryMock => ({ ...pending(), isError: true });
const settle = (data: CajaMock | null) => {
  cajaQuery.value = { isSuccess: true, isError: false, data, resultError: undefined };
};

describe('CheckoutPanel caja gate (restore)', () => {
  beforeEach(() => {
    useCartStore.setState({ items: [], ownerCajaSessionId: null });
    cajaQuery.value = pending();
    cachedCaja.value = null;
    vi.mocked(useStaffStore).mockImplementation(((fn: (s: unknown) => unknown) =>
      fn({ currentStaff: staff })) as never);
    vi.mocked(useCategories).mockReturnValue({ data: undefined } as ReturnType<typeof useCategories>);
  });

  it('renders nothing while the current caja query is pending', () => {
    const { container } = renderWithProviders(<CheckoutPanel />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('product-grid-mock')).toBeNull();
  });

  it('renders the till once the query settles', async () => {
    settle({ id: CAJA_A, status: 'open' });
    renderWithProviders(<CheckoutPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('product-grid-mock')).toBeInTheDocument();
    });
  });

  it('keeps and stamps a v2 cart with the first open caja', async () => {
    useCartStore.getState().addItem(product, []);
    settle({ id: CAJA_A, status: 'open' });
    renderHook(() => useSavedSale());
    await waitFor(() => {
      expect(useCartStore.getState().ownerCajaSessionId).toBe(CAJA_A);
    });
    expect(useCartStore.getState().items).toHaveLength(1);
  });

  it('purges a cart owned by a closed caja after the query confirms', async () => {
    useCartStore.getState().addItem(product, []);
    useCartStore.getState().setOwnerCajaSessionId(CAJA_A);
    settle({ id: CAJA_B, status: 'open' });
    renderHook(() => useSavedSale());
    await waitFor(() => {
      expect(useCartStore.getState().items).toHaveLength(0);
    });
    expect(useCartStore.getState().ownerCajaSessionId).toBeNull();
  });

  it('purges when the caja closes during the session', async () => {
    useCartStore.getState().addItem(product, []);
    settle({ id: CAJA_A, status: 'open' });
    const { rerender } = renderHook(() => useSavedSale());
    await waitFor(() => {
      expect(useCartStore.getState().ownerCajaSessionId).toBe(CAJA_A);
    });
    settle(null);
    rerender();
    await waitFor(() => {
      expect(useCartStore.getState().items).toHaveLength(0);
    });
  });

  it('keeps an owned cart when the caja query errors', () => {
    useCartStore.getState().addItem(product, []);
    useCartStore.getState().setOwnerCajaSessionId(CAJA_A);
    cajaQuery.value = errored();
    cachedCaja.value = { id: CAJA_B, status: 'open' };
    const { result } = renderHook(() => useSavedSale());
    expect(result.current.state).toBe('selling');
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().ownerCajaSessionId).toBe(CAJA_A);
  });

  it('cached caja counts only when status is open', async () => {
    useCartStore.getState().addItem(product, []);
    cajaQuery.value = errored();
    cachedCaja.value = { id: CAJA_A, status: 'closed' };
    const { rerender } = renderHook(() => useSavedSale());
    expect(useCartStore.getState().ownerCajaSessionId).toBeNull();
    cachedCaja.value = { id: CAJA_B, status: 'open' };
    rerender();
    await waitFor(() => {
      expect(useCartStore.getState().ownerCajaSessionId).toBe(CAJA_B);
    });
  });
});

describe('CheckoutPanel checkout rung (resume, cancel, done)', () => {
  const draft: CheckoutDraft = {
    method: 'cash',
    tenderedCents: 2500,
    splitLegs: [],
    discount: null,
    reference: null,
  };
  const KEY = 'direct_sale_1700000000000_abcd1234';

  beforeEach(() => {
    useCartStore.getState().clearCart();
    cajaQuery.value = pending();
    cachedCaja.value = null;
    vi.mocked(useStaffStore).mockImplementation(((fn: (s: unknown) => unknown) =>
      fn({ currentStaff: staff })) as never);
    vi.mocked(useCategories).mockReturnValue({ data: undefined } as ReturnType<typeof useCategories>);
  });

  function seedOpenCheckout() {
    useCartStore.getState().addItem(product, []);
    useCartStore.setState({
      ownerCajaSessionId: CAJA_A,
      checkout: { open: true, draft },
      pendingIdempotencyKey: KEY,
      pendingIdempotencyFingerprint: 'fp',
    });
    settle({ id: CAJA_A, status: 'open' });
  }

  it('checkout open at mount shows the Resume dialog', async () => {
    seedOpenCheckout();
    renderWithProviders(<CheckoutPanel />);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Product A')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-form')).toBeNull();
  });

  it('Resume opens PaymentForm with the persisted draft', async () => {
    seedOpenCheckout();
    renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resume Sale' }));
    const form = await screen.findByTestId('payment-form');
    expect(form).toHaveAttribute('data-tendered', '2500');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Discard keeps the cart, clears checkout and persists the restored line ids', async () => {
    seedOpenCheckout();
    const lineId = useCartStore.getState().items[0]?.tempId;
    renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard Checkout' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    const s = useCartStore.getState();
    expect(s.checkout).toBeNull();
    expect(s.items).toHaveLength(1);
    expect(s.restoredSnapshotLineIds).toEqual([lineId]);
    expect(screen.queryByTestId('payment-form')).toBeNull();
  });

  it('Cancel clears checkout only', async () => {
    useCartStore.getState().addItem(product, []);
    useCartStore.setState({ ownerCajaSessionId: CAJA_A, pendingIdempotencyKey: KEY, pendingIdempotencyFingerprint: 'fp' });
    settle({ id: CAJA_A, status: 'open' });
    renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /process payment/i }));
    // a marker written during the session (not found at mount) never triggers recovery
    useCartStore.getState().setSubmission({ key: KEY, startedAt: 1 });
    expect(useCartStore.getState().checkout?.open).toBe(true);
    await userEvent.click(await screen.findByRole('button', { name: 'mock-cancel' }));
    const s = useCartStore.getState();
    expect(s.checkout).toBeNull();
    expect(s.items).toHaveLength(1);
    expect(s.pendingIdempotencyKey).toBe(KEY);
    expect(s.submission).toEqual({ key: KEY, startedAt: 1 });
  });

  it('Done clears cart, key, checkout, submission and the restored line ids', async () => {
    seedOpenCheckout();
    useCartStore.getState().setRestoredSnapshotLineIds(['x']);
    renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resume Sale' }));
    useCartStore.getState().setSubmission({ key: KEY, startedAt: 1 });
    await userEvent.click(await screen.findByRole('button', { name: 'mock-done' }));
    const s = useCartStore.getState();
    expect(s.items).toEqual([]);
    expect(s.pendingIdempotencyKey).toBeNull();
    expect(s.checkout).toBeNull();
    expect(s.submission).toBeNull();
    expect(s.restoredSnapshotLineIds).toEqual([]);
  });
});

describe('CheckoutPanel restored-sale review (D-03)', () => {
  const draft: CheckoutDraft = {
    method: 'cash',
    tenderedCents: 1000,
    splitLegs: [],
    discount: null,
    reference: null,
  };
  const BLOCKED = 'Review the changed items above before paying.';
  const CHECKING = 'Checking current prices and stock.';

  /** Saved price 10.00 (the product above); the catalog now says `priceNow`. */
  const setCatalog = (priceNow: number, stock: number | null = null) => {
    catalog.products = [{ ...product, basePrice: priceNow }];
    catalog.inventory = stock === null ? [] : [{ productId: product.id, quantityOnHand: stock }];
  };

  beforeEach(() => {
    window.localStorage.clear();
    useCartStore.getState().clearCart();
    cajaQuery.value = pending();
    cachedCaja.value = null;
    catalog.dates = [];
    setCatalog(10);
    vi.mocked(useStaffStore).mockImplementation(((fn: (s: unknown) => unknown) =>
      fn({ currentStaff: staff })) as never);
    vi.mocked(useCategories).mockReturnValue({ data: undefined } as ReturnType<typeof useCategories>);
    useCartStore.getState().addItem(product, []);
    useCartStore.setState({ ownerCajaSessionId: CAJA_A, checkout: { open: true, draft } });
    settle({ id: CAJA_A, status: 'open' });
  });

  async function resume() {
    const view = renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Resume Sale' }));
    await screen.findByTestId('payment-form');
    return view;
  }
  const blockedReason = () => screen.getByTestId('payment-form').getAttribute('data-blocked');

  it('Resume with a changed price keeps the saved price in the cart and blocks Pay', async () => {
    setCatalog(11);
    await resume();
    expect(await screen.findByTestId('basket-conflict')).toHaveTextContent('Price changed');
    expect(blockedReason()).toBe(BLOCKED);
    const line = useCartStore.getState().items[0];
    expect(line?.unitPrice).toBe(10);
    expect(line?.lineTotal).toBe(10);
  });

  it('accepting every conflict enables Pay and the cart still holds saved prices', async () => {
    setCatalog(11);
    await resume();
    await userEvent.click(await screen.findByRole('button', { name: 'Accept Current Values' }));
    await waitFor(() => {
      expect(blockedReason()).toBe('');
    });
    expect(useCartStore.getState().items[0]?.unitPrice).toBe(10);
    expect(useCartStore.getState().restoredSnapshotLineIds).toEqual([]);
  });

  it('removing the conflicted line enables Pay', async () => {
    setCatalog(11);
    await resume();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Item' }));
    await waitFor(() => {
      expect(blockedReason()).toBe('');
    });
    expect(useCartStore.getState().items).toHaveLength(0);
    expect(useCartStore.getState().restoredSnapshotLineIds).toEqual([]);
  });

  it('an accepted conflict blocks again when the current value changes', async () => {
    setCatalog(11, 0); // price changed AND out of stock: the line stays under review
    const view = await resume();
    const rows = await screen.findAllByTestId('basket-conflict');
    expect(rows).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Accept Current Values' })[0] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Accepted' })).toBeDisabled();
    expect(blockedReason()).toBe(BLOCKED);

    setCatalog(12, 0);
    view.rerender(<CheckoutPanel />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Accept Current Values' })).toHaveLength(2);
    });
    expect(screen.queryByRole('button', { name: 'Accepted' })).toBeNull();
    expect(screen.getByText('$12.00')).toBeInTheDocument();
    expect(blockedReason()).toBe(BLOCKED);
  });

  it('Discard then reopening payment still blocks Pay on an unaccepted conflict', async () => {
    setCatalog(11);
    renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard Checkout' }));
    await userEvent.click(await screen.findByRole('button', { name: /process payment/i }));
    await screen.findByTestId('payment-form');
    expect(await screen.findByTestId('basket-conflict')).toBeInTheDocument();
    expect(blockedReason()).toBe(BLOCKED);
  });

  it('Discard, then rehydrate the store (simulated reload): a changed price still holds Pay until accepted', async () => {
    setCatalog(11);
    const first = renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard Checkout' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    first.unmount();

    // a reload: the in-memory store is lost, only what was persisted comes back
    const persisted = window.localStorage.getItem('direct-sale-held-cart');
    expect(persisted).not.toBeNull();
    useCartStore.setState({ items: [], restoredSnapshotLineIds: [], checkout: null, ownerCajaSessionId: null });
    window.localStorage.setItem('direct-sale-held-cart', persisted ?? ''); // setState above re-persisted
    await useCartStore.persist.rehydrate();
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().restoredSnapshotLineIds).toHaveLength(1);

    renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: /process payment/i }));
    await screen.findByTestId('payment-form');
    expect(await screen.findByTestId('basket-conflict')).toBeInTheDocument();
    expect(blockedReason()).toBe(BLOCKED);
    await userEvent.click(screen.getByRole('button', { name: 'Accept Current Values' }));
    await waitFor(() => {
      expect(blockedReason()).toBe('');
    });
  });

  it('while the current-catalog query is pending, Pay is disabled and the conflict.checking reason is shown', async () => {
    catalog.products = undefined;
    await resume();
    expect(blockedReason()).toBe(CHECKING);
    expect(screen.queryByTestId('basket-conflict')).toBeNull();
  });

  it('no conflicts: Pay is enabled right after Resume', async () => {
    await resume();
    await waitFor(() => {
      expect(blockedReason()).toBe('');
    });
    expect(screen.queryByTestId('basket-conflict')).toBeNull();
  });
});

describe('CheckoutPanel submission recovery (CART-04)', () => {
  const draft: CheckoutDraft = { method: 'cash', tenderedCents: 2500, splitLegs: [], discount: null, reference: null };
  const KEY = 'direct_sale_1700000000000_abcd1234';
  const never = () => new Promise(() => undefined);

  function seedMarker(startedAt: number) {
    useCartStore.getState().addItem(product, []);
    useCartStore.setState({
      ownerCajaSessionId: CAJA_A,
      checkout: { open: true, draft },
      pendingIdempotencyKey: KEY,
      pendingIdempotencyFingerprint: 'fp',
      submission: { key: KEY, startedAt },
    });
    settle({ id: CAJA_A, status: 'open' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useCartStore.getState().clearCart();
    cajaQuery.value = pending();
    cachedCaja.value = null;
    vi.mocked(useStaffStore).mockImplementation(((fn: (s: unknown) => unknown) =>
      fn({ currentStaff: staff })) as never);
    vi.mocked(useCategories).mockReturnValue({ data: undefined } as ReturnType<typeof useCategories>);
  });

  it('marker at mount shows PaymentRecovery before the Resume dialog', async () => {
    lookup.mockImplementation(never);
    seedMarker(Date.now());
    renderWithProviders(<CheckoutPanel />);
    expect(await screen.findByTestId('payment-recovery')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume Sale' })).toBeNull();
  });

  it('no cart or payment control is rendered during recovery', async () => {
    lookup.mockImplementation(never);
    seedMarker(Date.now());
    renderWithProviders(<CheckoutPanel />);
    await screen.findByTestId('payment-recovery');
    expect(screen.queryByTestId('product-grid-mock')).toBeNull();
    expect(screen.queryByTestId('payment-form')).toBeNull();
    expect(screen.queryByRole('button', { name: /process payment/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /clear|hold/i })).toBeNull();
  });

  it('completed lookup opens the receipt and never prints', async () => {
    lookup.mockResolvedValue(ok({ status: 'completed', paymentId: 'p1', tabId: 'tab-9' }));
    fetchReceipt.mockResolvedValue({ receiptNumber: 'R-77' });
    seedMarker(Date.now());
    renderWithProviders(<CheckoutPanel />);
    const form = await screen.findByTestId('payment-form');
    expect(form).toHaveAttribute('data-receipt', 'R-77');
    expect(fetchReceipt).toHaveBeenCalledWith('tab-9');
    expect(screen.queryByTestId('payment-recovery')).toBeNull();
    // (PaymentForm is mocked here; its no-print guarantee for initialReceipt is tested in PaymentForm.restore)
    // Done finishes the sale: cart, key, checkout and marker all cleared
    await userEvent.click(screen.getByRole('button', { name: 'mock-done' }));
    const s = useCartStore.getState();
    expect([s.items.length, s.pendingIdempotencyKey, s.checkout, s.submission]).toEqual([0, null, null, null]);
  });

  it('incomplete restores the draft and the original key and clears the marker', async () => {
    lookup.mockResolvedValue(ok({ status: 'not_completed' }));
    seedMarker(Date.now() - SUBMISSION_SETTLE_MS - 1);
    renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const form = await screen.findByTestId('payment-form');
    expect(form).toHaveAttribute('data-tendered', '2500');
    const s = useCartStore.getState();
    expect(s.submission).toBeNull();
    expect(s.pendingIdempotencyKey).toBe(KEY);
    expect(s.pendingIdempotencyFingerprint).toBe('fp');
    expect(s.checkout?.draft).toEqual(draft);
    expect(s.items).toHaveLength(1);
  });

  it('no payment request is sent without Pay', async () => {
    lookup.mockResolvedValue(ok({ status: 'not_completed' }));
    seedMarker(Date.now() - SUBMISSION_SETTLE_MS - 1);
    renderWithProviders(<CheckoutPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByTestId('payment-form');
    for (const spy of Object.values(checkoutProcessors)) expect(spy).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1); // read-only lookups only
  });

  it('unknown keeps the marker', async () => {
    lookup.mockResolvedValue(err({ code: 'NETWORK_OFFLINE', message: 'offline' }));
    seedMarker(Date.now() - SUBMISSION_SETTLE_MS - 1);
    renderWithProviders(<CheckoutPanel />);
    expect(await screen.findByRole('button', { name: 'Retry Status Check' })).toBeEnabled();
    expect(screen.queryByTestId('payment-form')).toBeNull();
    expect(useCartStore.getState().submission).toEqual({ key: KEY, startedAt: expect.any(Number) as number });
    expect(useCartStore.getState().pendingIdempotencyKey).toBe(KEY);
  });
});
