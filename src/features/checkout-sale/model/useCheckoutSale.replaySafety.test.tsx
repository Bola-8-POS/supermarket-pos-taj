/**
 * Widget-seam regression test for whole-branch review Finding 1: the
 * persisted, fingerprint-bound checkout idempotency key (Task 6) must
 * actually be the key that reaches the network, once PaymentForm (the real
 * consumer, via CheckoutPanel) is wired to useCheckoutSale's real processors
 * — not just when the hook is exercised in isolation via renderHook.
 *
 * PaymentForm mints its own `idempotencyKeyRef` per mount and always passes
 * it as the trailing `idempotencyKeyOverride` argument on every processor
 * call. Before the fix, useCheckoutSale.submit() let that override replace
 * the persisted key, so an app restart (PaymentForm remounts with an empty
 * ref, mints a fresh key) followed by a retry of an already-committed sale
 * would resend a brand-new idempotency key and double-charge. This test
 * renders the real PaymentForm + real useCheckoutSale + real cartStore /
 * staffStore / cajaStore together (mirroring CheckoutPanel's own wiring) and
 * mocks only the network boundary (`callProcessDirectSale`) plus the
 * printer/settings/permissions infrastructure PaymentForm needs to render.
 */

import { renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PaymentForm } from '@widgets/PaymentModal/ui/PaymentForm';
import { useCajaStore } from '@entities/caja';
import { useStaffStore } from '@entities/staff';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CajaSession, CartItem, Product, Shift, Staff } from '@shared/lib/domain';
import type * as EdgeContracts from '@shared/lib/edge-function-contracts';
import type * as PosPrinter from '@shared/lib/pos-printer';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';

import { cartItemsToRpcItems, computeSaleFingerprint, useCheckoutSale } from './useCheckoutSale';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, ready: true }),
}));

vi.mock('@entities/settings', () => ({
  useSettings: () => ({
    data: {
      billing: {
        taxRatePercent: 0,
        taxInclusive: true,
        paymentMethods: { cash: true, card: true, bank_transfer: true, rappi: true, uber_eats: true },
      },
      paymentLabels: undefined,
      general: { timezone: 'America/Mexico_City' },
    },
  }),
  useReceiptSettings: () => ({ data: undefined }),
}));

vi.mock('@entities/promotion', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, usePromotions: () => ({ data: [] }) };
});

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return {
    ...actual,
    // Plain literals, not the imported `ok()` helper — vi.mock factories are
    // hoisted above this file's own imports, so calling an imported binding
    // inside one is order-dependent (broke only when this file ran as part
    // of the full suite, not in isolation).
    printReceipt: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
    openCashDrawer: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
  };
});

const mockCallProcessDirectSale = vi.fn();
// Partial: the offline-sale entity (imported by useCheckoutSale) builds its record
// schema from this module's own request schema, so the real exports must stay.
vi.mock('@shared/lib/edge-function-contracts', async importOriginal => ({
  ...(await importOriginal<typeof EdgeContracts>()),
  callProcessDirectSale: (request: unknown) =>
    (mockCallProcessDirectSale as (r: unknown) => unknown)(request),
}));

vi.mock('@shared/lib/connectivity', () => ({
  isOnline: () => true,
  useOnlineStatus: () => true,
}));

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
  id: 'prod-restart-1',
  name: 'Restart Test Product',
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
  tempId: 'temp-restart-1',
  product,
  quantity: 1,
  selectedModifiers: [],
  unitPrice: 20,
  notes: '',
  lineTotal: 20,
};

/** Mirrors CheckoutPanel's own PaymentForm wiring (CheckoutPanel.tsx:307-320). */
function CheckoutSeam() {
  const { syntheticTab, processors } = useCheckoutSale();
  return (
    <PaymentForm
      tab={syntheticTab}
      staffId={staff.id}
      processors={processors}
      onPaymentSuccess={() => undefined}
    />
  );
}

/**
 * Mirrors CheckoutPanel's full paymentOpen/onClose/onDone lifecycle
 * (CheckoutPanel.tsx:303-334, post opus-re-review fix): Cancel only hides
 * the payment screen (no key reset); Done clears the cart, which is the
 * sole place that nulls the persisted idempotency key. `restart` remounts
 * this whole component fresh (as an app restart or a route navigation
 * away-and-back would), starting again at the cart screen (paymentOpen
 * reset to its initial value) while the underlying cartStore — a module
 * singleton, standing in for what a real restart rehydrates from
 * localStorage — is untouched.
 */
function CheckoutSeamWithLifecycle({ startOnPayment = true }: { startOnPayment?: boolean }) {
  const [paymentOpen, setPaymentOpen] = useState(startOnPayment);
  const { syntheticTab, processors } = useCheckoutSale();
  const clearCart = useCartStore(state => state.clearCart);
  if (!paymentOpen) {
    return (
      <button
        type="button"
        onClick={() => {
          setPaymentOpen(true);
        }}
      >
        Pay
      </button>
    );
  }
  return (
    <PaymentForm
      tab={syntheticTab}
      staffId={staff.id}
      processors={processors}
      onPaymentSuccess={() => undefined}
      onClose={() => {
        setPaymentOpen(false);
      }}
      onDone={() => {
        clearCart();
        setPaymentOpen(false);
      }}
    />
  );
}

describe('checkout-sale replay safety — PaymentForm/useCheckoutSale widget seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallProcessDirectSale.mockResolvedValue(
      ok({
        paymentId: 'p1',
        receiptData: {
          receiptNumber: 'R001',
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
      })
    );
    useCartStore.setState({
      items: [cartItem],
      pendingIdempotencyKey: null,
      pendingIdempotencyFingerprint: null,
      heldCart: null,
      comboResult: null,
    });
    useStaffStore.setState({
      currentStaff: staff,
      currentShift: shift,
      staffList: [],
      isAuthenticated: true,
    });
    useCajaStore.setState({ currentCaja: caja, isCajaOpen: true });
  });

  it('sends the persisted fingerprint-bound key, not PaymentForm\'s own freshly minted override, after a simulated restart', async () => {
    const user = userEvent.setup();
    // Simulates the pre-restart state: a checkout was already submitted and
    // persisted its key (Task 6), but the app was killed before the client
    // ever saw the RPC's response — the cart itself is untouched, so the
    // fingerprint still matches.
    const persistedKey = 'direct_sale_1759000000000_abcdef12';
    const fingerprint = computeSaleFingerprint(cartItemsToRpcItems([cartItem]), undefined);
    useCartStore.getState().setPendingIdempotencyKey(persistedKey, fingerprint);

    // PaymentForm is a fresh mount (as it would be after an app restart),
    // so its own idempotencyKeyRef is empty and it will mint and pass a
    // brand-new override on this call — the persisted key must win anyway.
    renderWithProviders(<CheckoutSeam />);

    await user.click(screen.getByTestId('quick-tender-exact'));
    await user.click(screen.getByRole('button', { name: 'Process payment' }));

    await waitFor(() => {
      expect(mockCallProcessDirectSale).toHaveBeenCalled();
    });
    const sentRequest = mockCallProcessDirectSale.mock.calls[0]?.[0] as {
      idempotencyKey: string;
    };
    expect(sentRequest.idempotencyKey).toBe(persistedKey);
  });
});

/**
 * Widget-seam regression tests for opus re-review Findings I-1/I-2 on Task
 * 6: two in-app retry paths that ended in a fresh idempotency key for a
 * cart that may already have been charged, both reachable without any app
 * restart. Both render the real CheckoutSeamWithLifecycle (PaymentForm +
 * useCheckoutSale + real cartStore, CheckoutPanel's actual onClose/onDone
 * wiring) and mock only the network boundary.
 */
describe('checkout-sale replay safety — success-without-Done and Cancel-then-retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCartStore.setState({
      items: [cartItem],
      pendingIdempotencyKey: null,
      pendingIdempotencyFingerprint: null,
      heldCart: null,
      comboResult: null,
    });
    useStaffStore.setState({
      currentStaff: staff,
      currentShift: shift,
      staffList: [],
      isAuthenticated: true,
    });
    useCajaStore.setState({ currentCaja: caja, isCajaOpen: true });
  });

  it('resends the same key on a same-cart retry when the sale succeeded but Done was never tapped (restart/navigate-away)', async () => {
    const user = userEvent.setup();
    mockCallProcessDirectSale.mockResolvedValue(
      ok({
        paymentId: 'p1',
        receiptData: {
          receiptNumber: 'R001',
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
      })
    );

    const first = renderWithProviders(<CheckoutSeamWithLifecycle />);
    await user.click(screen.getByTestId('quick-tender-exact'));
    await user.click(screen.getByRole('button', { name: 'Process payment' }));
    await waitFor(() => {
      expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(1);
    });
    // The sale committed (ReceiptPreview is now showing) but the cashier
    // never tapped Done — the cart (and its key) is still untouched.
    await screen.findByText(/R001/);
    const firstKey = (mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string })
      .idempotencyKey;
    first.unmount();

    // Simulate the restart/navigate-away-and-back: a fresh mount, same
    // (untouched) cartStore, PaymentForm has a brand-new empty
    // idempotencyKeyRef of its own.
    renderWithProviders(<CheckoutSeamWithLifecycle />);
    await user.click(screen.getByTestId('quick-tender-exact'));
    await user.click(screen.getByRole('button', { name: 'Process payment' }));
    await waitFor(() => {
      expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(2);
    });
    const secondKey = (mockCallProcessDirectSale.mock.calls[1]?.[0] as { idempotencyKey: string })
      .idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });

  it('resends the same key on a same-cart retry after Cancel following a lost response', async () => {
    const user = userEvent.setup();
    // First attempt: the RPC call rejects (simulates the connection dropping
    // mid-response — a lost response, not a decline).
    mockCallProcessDirectSale.mockResolvedValueOnce(
      err({ code: 'UNKNOWN_ERROR', message: 'network dropped' })
    );

    renderWithProviders(<CheckoutSeamWithLifecycle />);
    await user.click(screen.getByTestId('quick-tender-exact'));
    await user.click(screen.getByRole('button', { name: 'Process payment' }));
    await waitFor(() => {
      expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(1);
    });
    const firstKey = (mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string })
      .idempotencyKey;

    // Cashier does the natural thing: Cancel, then reopen and Pay again
    // without touching the cart.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Pay' }));

    mockCallProcessDirectSale.mockResolvedValueOnce(
      ok({
        paymentId: 'p1',
        receiptData: {
          receiptNumber: 'R002',
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
      })
    );
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

/**
 * Widget-seam regression test for opus re-review F2 round 1, Important
 * (new): a restored paid cart's persisted key survives until the cart is
 * reset (Task 6 / I-1 fix above) — but until this fix, emptying the cart
 * one line at a time (remove / qty-to-zero) never reset it, unlike
 * clearCart(). A cashier who empties a restored-but-unfinished cart that
 * way (rather than tapping "Clear cart") and then rings up a NEW customer
 * with an identical cart would silently reuse the stale key: the fingerprint
 * matches (same items), so submit() would resend the old key and
 * process_direct_sale_atomic would replay the original (already-paid) sale
 * — no new sale recorded, no stock decrement, and the caja short by that
 * amount.
 */
describe('checkout-sale replay safety — cart emptied line-by-line then rebuilt for a new sale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallProcessDirectSale.mockResolvedValue(
      ok({
        paymentId: 'p2',
        receiptData: {
          receiptNumber: 'R900',
          tabId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
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
      })
    );
    useCartStore.setState({
      items: [cartItem],
      pendingIdempotencyKey: null,
      pendingIdempotencyFingerprint: null,
      heldCart: null,
      comboResult: null,
    });
    useStaffStore.setState({
      currentStaff: staff,
      currentShift: shift,
      staffList: [],
      isAuthenticated: true,
    });
    useCajaStore.setState({ currentCaja: caja, isCajaOpen: true });
  });

  it('mints a fresh key for a new sale after a restored paid cart was emptied line by line and rebuilt', async () => {
    // Restored paid cart: a key was minted for this exact cart content
    // (e.g. the app restarted before Done was tapped) and never cleared.
    const staleKey = 'direct_sale_1759000000000_stalekey01';
    const fingerprint = computeSaleFingerprint(cartItemsToRpcItems([cartItem]), undefined);
    useCartStore.getState().setPendingIdempotencyKey(staleKey, fingerprint);

    // Cashier empties the cart one line at a time instead of "Clear cart".
    useCartStore.getState().removeItem(cartItem.tempId);
    expect(useCartStore.getState().items).toHaveLength(0);

    // A new customer's cart happens to be identical in content.
    useCartStore.getState().addItem(product, []);

    const { result } = renderHook(() => useCheckoutSale());
    await result.current.processors.processCashPayment('tab-1', 20, 20);

    const sentRequest = mockCallProcessDirectSale.mock.calls[0]?.[0] as {
      idempotencyKey: string;
    };
    expect(sentRequest.idempotencyKey).not.toBe(staleKey);
  });
});
