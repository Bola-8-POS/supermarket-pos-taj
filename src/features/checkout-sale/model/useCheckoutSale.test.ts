import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CajaSession, CartItem, Product, Shift, Staff } from '@shared/lib/domain';

import { useCheckoutSale } from './useCheckoutSale';

// ---------------------------------------------------------------------------
// Mocks — mirrors useScanBarcodeToCart.test.ts's selector-passthrough shape,
// extended to useCheckoutSale's 3-Zustand-store dependency.
// ---------------------------------------------------------------------------

vi.mock('@entities/tab/model/cartStore', () => ({
  useCartStore: (selector: (state: { items: CartItem[] }) => unknown) =>
    selector({ items: cartState.items }),
  calcWeightedLineTotal: (pricePerKg: number, weightGrams: number) =>
    Math.round(pricePerKg * (weightGrams / 1000) * 100) / 100,
}));

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
vi.mock('@shared/lib/edge-function-contracts', () => ({
  callProcessDirectSale: (request: unknown) =>
    (mockCallProcessDirectSale as (r: unknown) => unknown)(request),
}));

const mockIsOnline = vi.fn(() => true);
vi.mock('@shared/lib/connectivity', () => ({
  isOnline: () => mockIsOnline(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const staff: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Ana Cashier',
  email: 'ana@example.com',
  role: 'cashier',
  pin: '0000',
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
  openedAt: new Date(),
  closedAt: null,
  openedBy: staff.id,
  closedBy: null,
  openingCash: 100,
  closingCash: null,
  notes: null,
  status: 'open',
};

const cartState: { items: CartItem[] } = { items: [] };
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns NETWORK_OFFLINE and never calls the edge function when offline', async () => {
    mockIsOnline.mockReturnValue(false);
    const { result } = renderHook(() => useCheckoutSale());

    const res = await result.current.processors.processCashPayment('tab-1', 10, 10);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_OFFLINE');
    }
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
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
