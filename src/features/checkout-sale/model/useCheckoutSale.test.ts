import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CajaSession, CartItem, Product, Shift, Staff } from '@shared/lib/domain';

import type * as EdgeContracts from '@shared/lib/edge-function-contracts';
import type * as LicenseStore from '@shared/lib/license/store';
import { cartItemsToRpcItems, computeSaleFingerprint, useCheckoutSale } from './useCheckoutSale';

// ---------------------------------------------------------------------------
// Mocks — mirrors useScanBarcodeToCart.test.ts's selector-passthrough shape,
// extended to useCheckoutSale's 3-Zustand-store dependency. `cartState` also
// carries the persisted idempotency key/fingerprint pair (offline-first
// Plan 01, Task 6) — `setPendingIdempotencyKey`/`clearPendingIdempotencyKey`
// write back into it, mirroring what the real cartStore's persist middleware
// does, so a test can assert on either the mock's calls or the resulting
// `cartState` value.
// ---------------------------------------------------------------------------

const setPendingIdempotencyKey = vi.fn((key: string, fingerprint: string) => {
  cartState.pendingIdempotencyKey = key;
  cartState.pendingIdempotencyFingerprint = fingerprint;
});
const clearPendingIdempotencyKey = vi.fn(() => {
  cartState.pendingIdempotencyKey = null;
  cartState.pendingIdempotencyFingerprint = null;
});

// getState() mirrors the real zustand store's static accessor — submit()
// reads the pending key/fingerprint through it (not a render-bound
// selector) so two calls issued before a re-render see each other's writes
// (opus re-review, M-3). Built inside the factory (not as an outer const)
// because vi.mock factories are hoisted above the rest of the file; only
// closures deferred until actual call time may reference `cartState` etc.
vi.mock('@entities/tab/model/cartStore', () => {
  type Snapshot = {
    items: CartItem[];
    pendingIdempotencyKey: string | null;
    pendingIdempotencyFingerprint: string | null;
    setPendingIdempotencyKey: (key: string, fingerprint: string) => void;
    clearPendingIdempotencyKey: () => void;
  };
  const snapshot = (): Snapshot => ({
    items: cartState.items,
    pendingIdempotencyKey: cartState.pendingIdempotencyKey,
    pendingIdempotencyFingerprint: cartState.pendingIdempotencyFingerprint,
    setPendingIdempotencyKey,
    clearPendingIdempotencyKey,
  });
  const useCartStore = Object.assign(
    (selector: (state: Snapshot) => unknown) => selector(snapshot()),
    { getState: snapshot }
  );
  return {
    useCartStore,
    calcWeightedLineTotal: (pricePerKg: number, weightGrams: number) =>
      Math.round(pricePerKg * (weightGrams / 1000) * 100) / 100,
  };
});

vi.mock('@entities/staff', () => ({
  useStaffStore: (
    selector: (state: { currentStaff: Staff | null; currentShift: Shift | null }) => unknown
  ) => selector({ currentStaff: staffState.currentStaff, currentShift: staffState.currentShift }),
}));

vi.mock('@entities/caja', () => ({
  useCajaStore: (
    selector: (state: { currentCaja: CajaSession | null; isCajaOpen: boolean }) => unknown
  ) => selector({ currentCaja: cajaState.currentCaja, isCajaOpen: cajaState.isCajaOpen }),
}));

const mockCallProcessDirectSale = vi.fn();
// Partial: the offline-sale entity (imported by useCheckoutSale) builds its record
// schema from this module's own request schema, so the real exports must stay.
vi.mock('@shared/lib/edge-function-contracts', async importOriginal => ({
  ...(await importOriginal<typeof EdgeContracts>()),
  callProcessDirectSale: (request: unknown) =>
    (mockCallProcessDirectSale as (r: unknown) => unknown)(request),
}));

const mockIsOnline = vi.fn(() => true);
vi.mock('@shared/lib/connectivity', () => ({
  isOnline: () => mockIsOnline(),
}));

const mockRequiresRevalidation = vi.fn(() => false);
vi.mock('@shared/lib/license/store', async importOriginal => ({
  ...(await importOriginal<typeof LicenseStore>()),
  requiresRevalidation: () => mockRequiresRevalidation(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const cartState: {
  items: CartItem[];
  pendingIdempotencyKey: string | null;
  pendingIdempotencyFingerprint: string | null;
} = { items: [], pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null };
const staffState: { currentStaff: Staff | null; currentShift: Shift | null } = {
  currentStaff: staff,
  currentShift: shift,
};
const cajaState: { currentCaja: CajaSession | null; isCajaOpen: boolean } = {
  currentCaja: caja,
  isCajaOpen: true,
};

function resetStores() {
  cartState.items = [];
  cartState.pendingIdempotencyKey = null;
  cartState.pendingIdempotencyFingerprint = null;
  staffState.currentStaff = staff;
  staffState.currentShift = shift;
  cajaState.currentCaja = caja;
  cajaState.isCajaOpen = true;
}

// ---------------------------------------------------------------------------
// useCheckoutSale.processors
// ---------------------------------------------------------------------------

describe('useCheckoutSale', () => {
  beforeEach(() => {
    resetStores();
    mockIsOnline.mockReturnValue(true);
    mockRequiresRevalidation.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns NETWORK_OFFLINE and never calls the edge function when offline and the sale cannot be rung offline', async () => {
    mockIsOnline.mockReturnValue(false);
    const { result } = renderHook(() => useCheckoutSale());

    // A sale carrying a discount is not offline-eligible (two-mode Plan 02b, Ruling 3):
    // it keeps today's refusal. An eligible offline sale is stored instead, see
    // useCheckoutSale.offline.test.ts.
    const res = await result.current.processors.processCashPayment('tab-1', 10, 10, {
      scope: 'all',
      type: 'percent',
      value: 10,
      amount: 1,
      managerOverride: false,
      approvalId: undefined,
      approverId: undefined,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_OFFLINE');
    }
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
  });

  it('refuses a sale when the terminal must revalidate and is back online', async () => {
    mockIsOnline.mockReturnValue(true);
    mockRequiresRevalidation.mockReturnValue(true);
    const { result } = renderHook(() => useCheckoutSale());
    const res = await result.current.processors.processCashPayment('tab-1', 10, 10);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('LICENSE_ERROR');
    expect(!res.ok && res.error.message).toMatch(/verifying its license/i);
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
  });

  it('keeps the offline answer (NETWORK_OFFLINE, not LICENSE_ERROR) while still offline', async () => {
    mockIsOnline.mockReturnValue(false);
    mockRequiresRevalidation.mockReturnValue(true);
    const { result } = renderHook(() => useCheckoutSale());
    const res = await result.current.processors.processCashPayment('tab-1', 10, 10);
    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
  });

  it('allows a sale again after a successful heartbeat clears the requirement', async () => {
    mockIsOnline.mockReturnValue(true);
    mockRequiresRevalidation.mockReturnValue(false);
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentId: 'p1', receiptData: { changeAmount: 0 } },
    });
    const { result } = renderHook(() => useCheckoutSale());
    await result.current.processors.processCashPayment('tab-1', 10, 10);
    expect(mockCallProcessDirectSale).toHaveBeenCalled();
  });

  it('returns CAJA_CLOSED and never calls the edge function when caja is not open', async () => {
    cajaState.isCajaOpen = false;
    cajaState.currentCaja = null;
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processCashPayment('tab-1', 10, 10);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('CAJA_CLOSED');
    }
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
  });

  it('returns CAJA_CLOSED when there is no logged-in staff/shift', async () => {
    staffState.currentStaff = null;
    staffState.currentShift = null;
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processCashPayment('tab-1', 10, 10);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('CAJA_CLOSED');
    }
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
  });

  it('processCashPayment returns ok with paymentId/changeAmount/receiptData on success', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentId: 'p1', receiptData: { changeAmount: 0 } },
    });
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processCashPayment('tab-1', 10, 10);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        paymentId: 'p1',
        changeAmount: 0,
        receiptData: { changeAmount: 0 },
      });
    }
    expect(mockCallProcessDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'POS-1' })
    );
  });

  it('processCardPayment returns ok with paymentId/receiptData on success', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentId: 'p1', receiptData: { changeAmount: 0 } },
    });
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processCardPayment('tab-1', 10);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ paymentId: 'p1', receiptData: { changeAmount: 0 } });
    }
  });

  it('processPlatformPayment returns ok with paymentId/receiptData on success and forwards method to the direct-sale request', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentId: 'p1', receiptData: { paymentMethod: 'rappi' } },
    });
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processPlatformPayment(
      'tab-1',
      10,
      'rappi',
      'RAPPI-ORDER-1'
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ paymentId: 'p1', receiptData: { paymentMethod: 'rappi' } });
    }
    expect(mockCallProcessDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'rappi', amount: 10, referenceNumber: 'RAPPI-ORDER-1' })
    );
  });

  it('processSplitPayment wraps the single sale-level receiptData in a one-element receipts array', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentGroupId: 'g1', paymentIds: ['p1', 'p2'], receiptData: { changeAmount: 0 } },
    });
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processSplitPayment(
      'tab-1',
      [
        { method: 'cash', amount: 5 },
        { method: 'card', amount: 5 },
      ],
      10
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        paymentGroupId: 'g1',
        paymentIds: ['p1', 'p2'],
        receipts: [{ changeAmount: 0 }],
      });
    }
  });

  it('processCashPayment returns UNKNOWN_ERROR (not a thrown exception) when the success envelope is missing paymentId/receiptData', async () => {
    mockCallProcessDirectSale.mockResolvedValue({ ok: true, data: {} });
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processCashPayment('tab-1', 10, 10);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('UNKNOWN_ERROR');
    }
  });

  it('processCashPayment propagates an edge-function error unchanged', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'boom' },
    });
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processCashPayment('tab-1', 10, 10);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toEqual({ code: 'SUPABASE_ERROR', message: 'boom' });
    }
  });

  it('processBankTransferPayment returns ok with paymentId/referenceCode/receiptData on success', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: {
        tabId: 'tab-1',
        paymentId: 'p1',
        receiptData: { paymentMethod: 'bank_transfer', terminalReference: '4829016' },
      },
    });
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processBankTransferPayment(
      'tab-1',
      10,
      'Ana Cliente',
      '5512345678'
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        paymentId: 'p1',
        referenceCode: '4829016',
        receiptData: { paymentMethod: 'bank_transfer', terminalReference: '4829016' },
      });
    }
  });

  it('processBankTransferPayment forwards customerName/customerPhone into the request', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: {
        tabId: 'tab-1',
        paymentId: 'p1',
        receiptData: { paymentMethod: 'bank_transfer', terminalReference: '4829016' },
      },
    });
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processBankTransferPayment(
      'tab-1',
      10,
      'Ana Cliente',
      '5512345678'
    );

    expect(mockCallProcessDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'bank_transfer',
        customerName: 'Ana Cliente',
        customerPhone: '5512345678',
      })
    );
  });

  // Rule 1 regression coverage (27-03): process_direct_sale_atomic's
  // PRICE_MISMATCH check validates unit_price against the product's raw
  // catalog price — submitting a promotion-discounted cart display price
  // here breaks checkout for every promoted item.
  it('submits the product catalog basePrice as unit_price, not a discounted cart display price', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentId: 'p1', receiptData: { changeAmount: 0 } },
    });
    const promotedProduct: Product = {
      id: 'prod-1',
      name: 'Promoted Product',
      categoryId: 'cat-1',
      basePrice: 100,
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
    cartState.items = [
      {
        tempId: 'temp-1',
        product: promotedProduct,
        quantity: 1,
        selectedModifiers: [],
        unitPrice: 80, // discounted display price (PROMO-03)
        notes: '',
        lineTotal: 80,
      },
    ];
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processCashPayment('tab-1', 80, 80);

    expect(mockCallProcessDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ productId: 'prod-1', unitPrice: 100 })],
      })
    );
  });

  it('submits the weight-adjusted catalog price for a weighted item, not the discounted lineTotal', async () => {
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentId: 'p1', receiptData: { changeAmount: 0 } },
    });
    const weightedProduct: Product = {
      id: 'prod-2',
      name: 'Loose Rice',
      categoryId: 'cat-1',
      basePrice: 10, // per-kg catalog price
      happyHourPrice: null,
      imageUrl: null,
      photoPath: null,
      isActive: true,
      soldByWeight: true,
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
    cartState.items = [
      {
        tempId: 'temp-2',
        product: weightedProduct,
        quantity: 1,
        weightGrams: 500,
        selectedModifiers: [],
        unitPrice: 8, // discounted per-kg display price (PROMO-03)
        notes: '',
        lineTotal: 4, // 8 * 0.5kg
      },
    ];
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processCashPayment('tab-1', 5, 5);

    expect(mockCallProcessDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({
        // 10 (catalog price/kg) * 0.5kg = 5, not the discounted lineTotal (4)
        items: [expect.objectContaining({ productId: 'prod-2', unitPrice: 5 })],
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Checkout idempotency key persistence (offline-first Plan 01, Task 6)
// ---------------------------------------------------------------------------

describe('useCheckoutSale idempotency key persistence', () => {
  const product: Product = {
    id: 'prod-9',
    name: 'Test Product',
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

  function cartItem(overrides: Partial<CartItem> = {}): CartItem {
    return {
      tempId: 'temp-9',
      product,
      quantity: 1,
      selectedModifiers: [],
      unitPrice: 20,
      notes: '',
      lineTotal: 20,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetStores();
    mockIsOnline.mockReturnValue(true);
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentId: 'p1', receiptData: { changeAmount: 0 } },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reuses a persisted idempotency key across a remount when the cart fingerprint still matches', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = 'direct_sale_1759000000000_abcdef12';
    cartState.pendingIdempotencyFingerprint = computeSaleFingerprint(
      cartItemsToRpcItems(cartState.items),
      undefined
    );
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processCashPayment('tab-1', 20, 20);

    expect(mockCallProcessDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'direct_sale_1759000000000_abcdef12' })
    );
  });

  it('persists a freshly minted key so a later remount can reuse it', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = null;
    cartState.pendingIdempotencyFingerprint = null;
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processCashPayment('tab-1', 20, 20);

    expect(setPendingIdempotencyKey).toHaveBeenCalledWith(
      expect.stringMatching(/^direct_sale_/),
      expect.any(String)
    );
  });

  // opus re-review, Finding I-1: submit() used to clear the persisted key
  // the moment the RPC returned ok, but the cart itself isn't reset until
  // the cashier taps Done (CheckoutPanel.tsx's onDone -> clearCart()). If
  // the app restarts or the cashier navigates away between "sale committed"
  // and "Done tapped", the cart reappears with items intact but no key, so
  // the next Pay press mints a fresh key and double-charges. The key must
  // survive success and be cleared only by the cart lifecycle
  // (clearCart/holdCart/resumeHeld), never by submit() itself.
  it('does NOT clear the persisted key on success — only clearCart (via the cart lifecycle) clears it', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = 'direct_sale_1759000000000_abcdef12';
    cartState.pendingIdempotencyFingerprint = computeSaleFingerprint(
      cartItemsToRpcItems(cartState.items),
      undefined
    );
    const { result } = renderHook(() => useCheckoutSale());

    const outcome = await result.current.processors.processCashPayment('tab-1', 20, 20);

    expect(outcome.ok).toBe(true);
    expect(clearPendingIdempotencyKey).not.toHaveBeenCalled();
    expect(cartState.pendingIdempotencyKey).toBe('direct_sale_1759000000000_abcdef12');
  });

  // opus re-review, Finding I-1 (restart-before-Done double charge): a sale
  // commits, the app is killed/navigated-away before Done is tapped, and
  // the cart (with its untouched persisted key) comes back. The retry with
  // the same unedited cart must resend the SAME key, not a new one, so the
  // RPC replays the original sale instead of charging a second time.
  it('resends the same key on a same-cart retry after a simulated restart with no Done click', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = null;
    cartState.pendingIdempotencyFingerprint = null;
    const { result: firstMount } = renderHook(() => useCheckoutSale());

    const first = await firstMount.current.processors.processCashPayment('tab-1', 20, 20);
    expect(first.ok).toBe(true);
    const firstKey = cartState.pendingIdempotencyKey;
    expect(firstKey).not.toBeNull();

    // Simulate a restart: a brand-new hook instance (fresh component tree),
    // same persisted cartState (items + key/fingerprint survived — nothing
    // reset them because Done was never tapped).
    const { result: secondMount } = renderHook(() => useCheckoutSale());
    await secondMount.current.processors.processCashPayment('tab-1', 20, 20);

    const secondRequest = mockCallProcessDirectSale.mock.calls[1]?.[0] as {
      idempotencyKey: string;
    };
    expect(secondRequest.idempotencyKey).toBe(firstKey);
  });

  it('mints a fresh key when the persisted key exists but the cart fingerprint no longer matches', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = 'direct_sale_1759000000000_abcdef12';
    // A fingerprint that does not describe the current cart — e.g. the
    // persisted pair survived a restart but nothing recomputed it for
    // whatever cart is now active (or it's simply stale/corrupt).
    cartState.pendingIdempotencyFingerprint = 'stale-fingerprint-from-a-different-cart';
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processCashPayment('tab-1', 20, 20);

    const sentRequest = mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(sentRequest.idempotencyKey).toMatch(/^direct_sale_/);
    expect(sentRequest.idempotencyKey).not.toBe('direct_sale_1759000000000_abcdef12');
    expect(setPendingIdempotencyKey).toHaveBeenCalledWith(
      sentRequest.idempotencyKey,
      expect.any(String)
    );
  });

  it('mints a fresh key when the cart quantity changed since the key was minted (edit after a failed attempt)', async () => {
    cartState.items = [cartItem({ quantity: 1, lineTotal: 20 })];
    cartState.pendingIdempotencyKey = 'direct_sale_1759000000000_abcdef12';
    cartState.pendingIdempotencyFingerprint = computeSaleFingerprint(
      cartItemsToRpcItems(cartState.items),
      undefined
    );
    // Cashier bumps quantity before retrying — a different sale-defining cart.
    cartState.items = [cartItem({ quantity: 2, lineTotal: 40 })];
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processCashPayment('tab-1', 40, 40);

    const sentRequest = mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(sentRequest.idempotencyKey).not.toBe('direct_sale_1759000000000_abcdef12');
  });

  it('mints a fresh key when a line is removed since the key was minted (edit after a failed attempt)', async () => {
    const secondProduct: Product = { ...product, id: 'prod-10' };
    cartState.items = [
      cartItem(),
      cartItem({ tempId: 'temp-10', product: secondProduct, lineTotal: 20 }),
    ];
    cartState.pendingIdempotencyKey = 'direct_sale_1759000000000_abcdef12';
    cartState.pendingIdempotencyFingerprint = computeSaleFingerprint(
      cartItemsToRpcItems(cartState.items),
      undefined
    );
    // Cashier removes the second line before retrying.
    cartState.items = [cartItem()];
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processCashPayment('tab-1', 20, 20);

    const sentRequest = mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(sentRequest.idempotencyKey).not.toBe('direct_sale_1759000000000_abcdef12');
  });

  it('mints a fresh key when a discount is applied that the persisted key was not minted for', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = 'direct_sale_1759000000000_abcdef12';
    cartState.pendingIdempotencyFingerprint = computeSaleFingerprint(
      cartItemsToRpcItems(cartState.items),
      undefined
    );
    const { result } = renderHook(() => useCheckoutSale());

    await result.current.processors.processCashPayment('tab-1', 18, 18, {
      scope: 'all',
      type: 'percent',
      value: 10,
      amount: 2,
      managerOverride: false,
      approvalId: undefined,
      approverId: undefined,
    });

    const sentRequest = mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(sentRequest.idempotencyKey).not.toBe('direct_sale_1759000000000_abcdef12');
    expect(setPendingIdempotencyKey).toHaveBeenCalledWith(
      sentRequest.idempotencyKey,
      expect.any(String)
    );
  });

  it('keeps reusing the persisted key when only the tendered amount/payment method change', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = 'direct_sale_1759000000000_abcdef12';
    cartState.pendingIdempotencyFingerprint = computeSaleFingerprint(
      cartItemsToRpcItems(cartState.items),
      undefined
    );
    const { result } = renderHook(() => useCheckoutSale());

    // Different payment method (card, not cash) and no tendered amount at
    // all — neither is part of the fingerprint.
    await result.current.processors.processCardPayment('tab-1', 20, 'REF-1');

    expect(mockCallProcessDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'direct_sale_1759000000000_abcdef12' })
    );
    expect(setPendingIdempotencyKey).not.toHaveBeenCalled();
  });

  // Whole-branch review, Finding 1: PaymentForm mints its own
  // idempotencyKeyRef and always passes it as idempotencyKeyOverride on
  // every processor call. On an app restart PaymentForm's ref is empty, so
  // it mints a fresh key — if submit() let that override replace the
  // fingerprint-bound persisted key, a retry after "RPC committed, response
  // lost, app killed" would resend a brand-new key and double-charge. The
  // persisted key must win whenever its fingerprint still matches, no
  // matter what override a caller supplies.
  it('ignores a caller-supplied idempotencyKeyOverride and sends the persisted fingerprint-matching key instead', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = 'direct_sale_1759000000000_abcdef12';
    cartState.pendingIdempotencyFingerprint = computeSaleFingerprint(
      cartItemsToRpcItems(cartState.items),
      undefined
    );
    const { result } = renderHook(() => useCheckoutSale());

    // Simulates PaymentForm's idempotencyKeyRef, freshly minted after a
    // restart, passed as the trailing override argument.
    await result.current.processors.processCashPayment(
      'tab-1',
      20,
      20,
      undefined,
      undefined,
      'payment_cash_1759999999999_freshoverride'
    );

    expect(mockCallProcessDirectSale).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'direct_sale_1759000000000_abcdef12' })
    );
    expect(setPendingIdempotencyKey).not.toHaveBeenCalled();
  });

  // opus re-review, Minor M-3: submit() used to read the persisted key from
  // a render-bound useCartStore selector. Two submit() calls issued back to
  // back (e.g. a double-click racing the isProcessing guard) both run their
  // synchronous prefix before either awaits callProcessDirectSale, so both
  // would close over the SAME stale (null) selector value and mint two
  // different keys for the one attempt. Reading via getState() instead
  // means the second call observes the first call's synchronous write.
  it('reuses the same key across two submit() calls issued before a re-render (double-click race)', async () => {
    cartState.items = [cartItem()];
    cartState.pendingIdempotencyKey = null;
    cartState.pendingIdempotencyFingerprint = null;
    const { result } = renderHook(() => useCheckoutSale());

    const [first, second] = await Promise.all([
      result.current.processors.processCashPayment('tab-1', 20, 20),
      result.current.processors.processCashPayment('tab-1', 20, 20),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstKey = (mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string })
      .idempotencyKey;
    const secondKey = (mockCallProcessDirectSale.mock.calls[1]?.[0] as { idempotencyKey: string })
      .idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });
});
