/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProvisionalReceipt, computeSaleIntegrity, useOfflineSaleStore } from '@entities/offline-sale';
import type * as OfflineSaleEntity from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import type * as Connectivity from '@shared/lib/connectivity';
import type { CajaSession, CartItem, Product, Shift, Staff } from '@shared/lib/domain';
import type * as EdgeContracts from '@shared/lib/edge-function-contracts';
import i18n from '@shared/lib/i18n';
import type * as LicenseStore from '@shared/lib/license/store';
import { networkOfflineError } from '@shared/lib/result';

import { offlineReasonKey } from './offlineReasons';
import { useCheckoutSale } from './useCheckoutSale';

// ---------------------------------------------------------------------------
// Mocks — same shape as useCheckoutSale.test.ts; the offline-sale store, the
// eligibility rules and the integrity hash are the REAL ones, so these tests
// exercise the hand-off into a persisted record end to end.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-09T12:00:00.000Z');

const setPendingIdempotencyKey = vi.fn((key: string, fingerprint: string) => {
  cartState.pendingIdempotencyKey = key;
  cartState.pendingIdempotencyFingerprint = fingerprint;
});
const clearPendingIdempotencyKey = vi.fn(() => {
  spy.order.push('clear-key');
  cartState.pendingIdempotencyKey = null;
  cartState.pendingIdempotencyFingerprint = null;
});

vi.mock('@entities/tab/model/cartStore', () => {
  type Snapshot = {
    items: CartItem[];
    pendingIdempotencyKey: string | null;
    pendingIdempotencyFingerprint: string | null;
    setPendingIdempotencyKey: (key: string, fingerprint: string) => void;
    clearPendingIdempotencyKey: () => void;
    setSubmission: () => void;
    clearSubmission: () => void;
    submission: null;
  };
  const snapshot = (): Snapshot => ({
    items: cartState.items,
    pendingIdempotencyKey: cartState.pendingIdempotencyKey,
    pendingIdempotencyFingerprint: cartState.pendingIdempotencyFingerprint,
    setPendingIdempotencyKey,
    clearPendingIdempotencyKey,
    setSubmission: () => undefined,
    clearSubmission: () => undefined,
    submission: null,
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

// Wraps the real receipt builder so a test can see WHEN it ran, and what the
// store held at that moment. Everything else in the entity stays real.
const spy = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('@entities/offline-sale', async importOriginal => {
  const actual = await importOriginal<typeof OfflineSaleEntity>();
  return {
    ...actual,
    computeSaleIntegrity: vi.fn(actual.computeSaleIntegrity),
    buildProvisionalReceipt: vi.fn((...args: Parameters<typeof actual.buildProvisionalReceipt>) => {
      spy.order.push(`receipt:records=${String(actual.useOfflineSaleStore.getState().records.length)}`);
      return actual.buildProvisionalReceipt(...args);
    }),
  };
});

const mockCallProcessDirectSale = vi.fn();
// Partial mock: the offline-sale entity validates records with the contracts' own
// request schema, so the module must keep its real exports.
vi.mock('@shared/lib/edge-function-contracts', async importOriginal => ({
  ...(await importOriginal<typeof EdgeContracts>()),
  callProcessDirectSale: (request: unknown) =>
    (mockCallProcessDirectSale as (r: unknown) => unknown)(request),
}));

const mockIsOnline = vi.fn(() => true);
const instance = vi.hoisted(() => ({ role: 'primary' as 'unknown' | 'primary' | 'secondary' }));
vi.mock('@shared/lib/instance-lock', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useInstanceRole: () => instance.role,
  getInstanceRole: () => instance.role,
}));

vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<typeof Connectivity>()),
  isOnline: () => mockIsOnline(),
}));

const mockRequiresRevalidation = vi.fn(() => false);
const mockLicenseState = vi.fn((): string => 'active');
vi.mock('@shared/lib/license/store', async importOriginal => ({
  ...(await importOriginal<typeof LicenseStore>()),
  requiresRevalidation: () => mockRequiresRevalidation(),
  currentLicenseEvaluation: () => ({ state: mockLicenseState() }),
  getEffectiveNow: () => NOW,
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

const product: Product = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Basmati rice 1kg',
  categoryId: '66666666-6666-4666-8666-666666666666',
  category: {
    id: '66666666-6666-4666-8666-666666666666',
    name: 'Rice',
    color: '#aabbcc',
    sortOrder: 0,
    happyHourStart: null,
    happyHourEnd: null,
    routing: 'NONE',
    comboEligible: true,
    createdAt: new Date(),
  },
  basePrice: 4.5,
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
  tempId: 'temp-1',
  product,
  quantity: 2,
  selectedModifiers: [],
  unitPrice: 4.5,
  notes: '',
  lineTotal: 9,
};

const STORE = { storeName: 'Tienda Test', address: 'Calle 1, Ciudad' };

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

const discount = {
  scope: 'all' as const,
  type: 'percent' as const,
  value: 10,
  amount: 0.9,
  managerOverride: true,
  approvalId: undefined,
  approverId: undefined,
};

// The processors are typed with the server receipt, which has no provisional marker.
const provisionalFlag = (receipt: unknown) => (receipt as { provisional?: boolean }).provisional;

function records() {
  return useOfflineSaleStore.getState().records;
}

function mountOffline(nearExpiryListUsable?: boolean) {
  return renderHook(() => useCheckoutSale(STORE, nearExpiryListUsable)).result.current;
}

describe('useCheckoutSale offline branch', () => {
  beforeEach(() => {
    spy.order.length = 0;
    cartState.items = [cartItem];
    cartState.pendingIdempotencyKey = null;
    cartState.pendingIdempotencyFingerprint = null;
    staffState.currentStaff = staff;
    staffState.currentShift = shift;
    cajaState.currentCaja = caja;
    cajaState.isCajaOpen = true;
    mockIsOnline.mockReturnValue(false);
    mockRequiresRevalidation.mockReturnValue(false);
    mockLicenseState.mockReturnValue('active');
    useOfflineSaleStore.setState({ records: [] });
    instance.role = 'primary';
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('offline eligible cash sale enqueues, never calls the edge function, returns provisional true', async () => {
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(provisionalFlag(res.data.receiptData)).toBe(true);
    expect(res.data.receiptData.total).toBe(9);
    expect(res.data.receiptData.changeAmount).toBe(1);
    expect(res.data.receiptData.storeName).toBe('Tienda Test');
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();

    expect(records()).toHaveLength(1);
    const [record] = records();
    expect(record).toMatchObject({
      status: 'queued',
      staffId: staff.id,
      staffName: 'Ana Cashier',
      soldAt: '2026-10-09T12:00:00.000Z',
      lines: [{ productId: product.id, name: 'Basmati rice 1kg', categoryName: 'Rice', modifierNames: [] }],
      request: {
        shiftId: shift.id,
        cajaSessionId: caja.id,
        terminalId: 'POS-1',
        method: 'cash',
        amount: 9,
        tenderedAmount: 10,
        idempotencyKey: expect.stringMatching(/^direct_sale_/) as string,
      },
    });
    expect(record?.receiptNumber).toBe(res.data.receiptData.receiptNumber);
  });

  it('offline card sale without reference is refused with the existing offline error', async () => {
    const { processors } = mountOffline();

    const res = await processors.processCardPayment('tab-1', 9);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NETWORK_OFFLINE');
    expect(res.error.message).toBe(networkOfflineError().message);
    expect((res.error as { details?: string }).details).toBe('card_reference_missing');
    expect(records()).toHaveLength(0);
    expect(clearPendingIdempotencyKey).not.toHaveBeenCalled();
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
  });

  it('the offline branch refuses a reference that looks like a card number', async () => {
    const { processors } = mountOffline();

    const single = await processors.processCardPayment('tab-1', 9, '4111 1111 1111 1111');
    expect(single).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(!single.ok && single.error.message).toMatch(/approval code, not the card number/i);

    const split = await processors.processSplitPayment('tab-1', [
      { method: 'cash', amount: 4, tenderedAmount: 4 },
      { method: 'card', amount: 5, referenceNumber: '4242-4242-4242-4242' },
    ], 9);
    expect(split).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });

    // nothing stored, nothing sent, and the card number never reached storage
    expect(records()).toHaveLength(0);
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
    expect(localStorage.getItem('offline-sales') ?? '').not.toContain('4111');

    // an approval code is still stored
    const ok = await processors.processCardPayment('tab-1', 9, '123456');
    expect(ok.ok).toBe(true);
    expect(records()[0]?.request.referenceNumber).toBe('123456');
  });

  it('offline card sale with a reference is stored with that reference', async () => {
    const { processors } = mountOffline();

    const res = await processors.processCardPayment('tab-1', 9, 'AUTH-7731');

    expect(res.ok).toBe(true);
    expect(records()[0]?.request).toMatchObject({ method: 'card', referenceNumber: 'AUTH-7731' });
  });

  it("offline sale with discount keeps today's NETWORK_OFFLINE", async () => {
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 8.1, 10, discount);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NETWORK_OFFLINE');
    expect(res.error.message).toBe(networkOfflineError().message);
    expect((res.error as { details?: string }).details).toBe('discount');
    expect(records()).toHaveLength(0);
  });

  it.each([
    ['rappi platform sale', 'method'],
    ['bank transfer', 'method'],
  ])('offline %s is refused (%s)', async (label, reason) => {
    const { processors } = mountOffline();

    const res =
      label === 'bank transfer'
        ? await processors.processBankTransferPayment('tab-1', 9, 'Ana', '5512345678')
        : await processors.processPlatformPayment('tab-1', 9, 'rappi', 'R-1');

    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(!res.ok && (res.error as { details?: string }).details).toBe(reason);
    expect(records()).toHaveLength(0);
  });

  it('offline split of cash and card is stored as one record with both legs', async () => {
    const { processors } = mountOffline();

    const res = await processors.processSplitPayment(
      'tab-1',
      [
        { method: 'cash', amount: 4, tenderedAmount: 5 },
        { method: 'card', amount: 5, referenceNumber: 'AUTH-1' },
      ],
      9
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.receipts).toHaveLength(1);
    expect(provisionalFlag(res.data.receipts[0])).toBe(true);
    expect(records()).toHaveLength(1);
    expect(records()[0]?.request.legs).toHaveLength(2);
  });

  it.each([
    ['restricted', 'license'],
    ['locked', 'license'],
  ])('offline sale under a %s licence is refused', async (state, reason) => {
    mockLicenseState.mockReturnValue(state);
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(!res.ok && (res.error as { details?: string }).details).toBe(reason);
    expect(records()).toHaveLength(0);
  });

  it('an offline sale is refused for revalidation when the near-expiry list cannot cover the threshold', async () => {
    const { processors } = mountOffline(false);

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(!res.ok && (res.error as { details?: string }).details).toBe('revalidation');
    expect(records()).toHaveLength(0);
  });

  it('offline sale without an open caja is refused', async () => {
    cajaState.isCajaOpen = false;
    cajaState.currentCaja = null;
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(!res.ok && (res.error as { details?: string }).details).toBe('no_open_caja');
  });

  it('offline sale is refused with limit_count at 500 pending records', async () => {
    useOfflineSaleStore.setState({
      records: Array.from({ length: 500 }, (_, i) =>
        makeSale({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          soldAt: '2026-10-09T11:00:00.000Z',
          request: { ...makeSale().request, idempotencyKey: `direct_sale_${String(i)}_abcd1234` },
        })
      ),
    });
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(!res.ok && (res.error as { details?: string }).details).toBe('limit_count');
    expect(records()).toHaveLength(500);
  });

  it('offline sale is refused with limit_age when the oldest pending sale is 24 hours old', async () => {
    useOfflineSaleStore.setState({ records: [makeSale({ soldAt: '2026-10-08T11:59:00.000Z' })] });
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(!res.ok && (res.error as { details?: string }).details).toBe('limit_age');
    expect(records()).toHaveLength(1);
  });

  it('double submit before re-render yields one record', async () => {
    const { processors } = mountOffline();

    const [first, second] = await Promise.all([
      processors.processCashPayment('tab-1', 9, 10),
      processors.processCashPayment('tab-1', 9, 10),
    ]);

    expect(first.ok && second.ok).toBe(true);
    expect(records()).toHaveLength(1);
    if (first.ok && second.ok) {
      expect(second.data.receiptData.receiptNumber).toBe(first.data.receiptData.receiptNumber);
    }
    const minted = setPendingIdempotencyKey.mock.calls.map(([key]) => key);
    expect(new Set(minted).size).toBe(1);
  });

  it('the record is persisted before the receipt is returned', async () => {
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(res.ok).toBe(true);
    // the receipt is built only once the record is in the store; the cart's key is
    // not touched (the cart lifecycle releases it, as online)
    expect(spy.order).toEqual(['receipt:records=1']);
    expect(clearPendingIdempotencyKey).not.toHaveBeenCalled();
  });

  it('a record that cannot be saved returns an error, keeps the cart key and builds no receipt', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('UNKNOWN_ERROR');
    expect(records()).toHaveLength(0);
    expect(buildProvisionalReceipt).not.toHaveBeenCalled();
    expect(clearPendingIdempotencyKey).not.toHaveBeenCalled();
    expect(cartState.pendingIdempotencyKey).not.toBeNull();
  });

  it('a second pay of the uncleared cart yields one record and the same receipt', async () => {
    const { processors } = mountOffline();

    const first = await processors.processCashPayment('tab-1', 9, 10);
    // closed / reloaded / navigated away before Done: the cart comes back full, key included
    const second = await processors.processCashPayment('tab-1', 9, 10);

    expect(first.ok && second.ok).toBe(true);
    expect(records()).toHaveLength(1);
    if (first.ok && second.ok) {
      expect(second.data.receiptData.receiptNumber).toBe(first.data.receiptData.receiptNumber);
    }
    expect(clearPendingIdempotencyKey).not.toHaveBeenCalled();
    expect(new Set(setPendingIdempotencyKey.mock.calls.map(([key]) => key)).size).toBe(1);
  });

  it('an integrity failure returns an error and leaves the form usable', async () => {
    vi.mocked(computeSaleIntegrity).mockRejectedValueOnce(new Error('subtle unavailable'));
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('UNKNOWN_ERROR');
    expect(records()).toHaveLength(0);
    expect(buildProvisionalReceipt).not.toHaveBeenCalled();
    expect(clearPendingIdempotencyKey).not.toHaveBeenCalled();
    expect(cartState.pendingIdempotencyKey).not.toBeNull();
  });

  it('the next sale gets a fresh key', async () => {
    const { processors } = mountOffline();

    await processors.processCashPayment('tab-1', 9, 10);
    // Done on the receipt screen: the cart lifecycle releases the key
    clearPendingIdempotencyKey();
    await processors.processCashPayment('tab-1', 9, 10);

    expect(records()).toHaveLength(2);
    const [a, b] = records();
    expect(a?.request.idempotencyKey).toBeTruthy();
    expect(b?.request.idempotencyKey).not.toBe(a?.request.idempotencyKey);
  });

  it('sell offline instead reuses the key of the unknown-outcome attempt', async () => {
    mockIsOnline.mockReturnValue(true);
    mockCallProcessDirectSale.mockResolvedValue({
      ok: false,
      error: { code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'unknown' },
    });
    const { processors } = mountOffline();

    const unknown = await processors.processCashPayment('tab-1', 9, 10);
    expect(!unknown.ok && unknown.error.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    const sentKey = (mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string })
      .idempotencyKey;
    expect(cartState.pendingIdempotencyKey).toBe(sentKey);

    const res = await processors.processCashPayment(
      'tab-1',
      9,
      10,
      undefined,
      undefined,
      undefined,
      { sellOffline: true }
    );

    expect(res.ok).toBe(true);
    expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(1);
    expect(records()[0]?.request.idempotencyKey).toBe(sentKey);
    expect(setPendingIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('sell offline instead is refused like any ineligible offline sale', async () => {
    mockIsOnline.mockReturnValue(true);
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 8.1, 10, discount, undefined, undefined, {
      sellOffline: true,
    });

    expect(!res.ok && res.error.code).toBe('NETWORK_OFFLINE');
    expect(!res.ok && (res.error as { details?: string }).details).toBe('discount');
    expect(records()).toHaveLength(0);
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
  });

  it('a secondary instance cannot sell offline and says why', async () => {
    const probe = { method: 'cash' as const, hasDiscount: false, hasOverride: false };
    // a second copy of the app in the same profile: its store write could erase the primary's sales
    for (const role of ['secondary', 'unknown'] as const) {
      instance.role = role;
      const { processors } = mountOffline();
      expect(processors.canSellOffline(probe), role).toBe(false);
      expect(processors.offlineRefusal(probe), role).toBe('secondary_instance');

      const res = await processors.processCashPayment('tab-1', 9, 10);
      expect(res, role).toMatchObject({
        ok: false,
        error: { code: 'NETWORK_OFFLINE', details: 'secondary_instance' },
      });
    }
    expect(records()).toHaveLength(0);
    // and the reason has words, in both locales, that name the other window
    expect(i18n.t(offlineReasonKey('secondary_instance'), { lng: 'en-US' })).toMatch(/another window/i);
    expect(i18n.t(offlineReasonKey('secondary_instance'), { lng: 'es-MX' })).toMatch(/otra ventana/i);

    instance.role = 'primary';
    expect(mountOffline().processors.offlineRefusal(probe)).toBeNull();
  });

  it('canSellOffline answers with the same rules submit applies', () => {
    mockIsOnline.mockReturnValue(true);
    const { processors } = mountOffline();
    const base = { hasDiscount: false, hasOverride: false };

    expect(processors.canSellOffline({ ...base, method: 'cash' })).toBe(true);
    expect(processors.canSellOffline({ ...base, method: 'card', referenceNumber: '' })).toBe(false);
    expect(processors.canSellOffline({ ...base, method: 'card', referenceNumber: 'A-1' })).toBe(true);
    expect(processors.canSellOffline({ ...base, method: 'rappi' })).toBe(false);
    expect(processors.canSellOffline({ ...base, method: 'cash', hasDiscount: true })).toBe(false);
    mockLicenseState.mockReturnValue('restricted');
    expect(processors.canSellOffline({ ...base, method: 'cash' })).toBe(false);
  });

  it('online path is byte-identical to before', async () => {
    mockIsOnline.mockReturnValue(true);
    mockCallProcessDirectSale.mockResolvedValue({
      ok: true,
      data: { paymentId: 'p1', receiptData: { changeAmount: 1 } },
    });
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(res.ok).toBe(true);
    expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(1);
    const sent = mockCallProcessDirectSale.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toStrictEqual({
      items: [
        {
          productId: product.id,
          quantity: 2,
          unitPrice: 4.5,
          modifierIds: [],
          modifierPriceDelta: 0,
          notes: null,
          weightGrams: undefined,
        },
      ],
      shiftId: shift.id,
      cajaSessionId: caja.id,
      idempotencyKey: cartState.pendingIdempotencyKey,
      terminalId: 'POS-1',
      method: 'cash',
      amount: 9,
      tenderedAmount: 10,
    });
    expect(records()).toHaveLength(0);
  });

  it('offlineRefusal names why a sale cannot be rung offline, null when it can', () => {
    mockIsOnline.mockReturnValue(true);
    const { processors } = mountOffline();
    const base = { hasDiscount: false, hasOverride: false };

    expect(processors.offlineRefusal({ ...base, method: 'cash' })).toBeNull();
    expect(processors.offlineRefusal({ ...base, method: 'rappi' })).toBe('method');
    expect(processors.offlineRefusal({ ...base, method: 'card', referenceNumber: '' })).toBe(
      'card_reference_missing'
    );
    expect(processors.offlineRefusal({ ...base, method: 'cash', hasDiscount: true })).toBe('discount');
    mockLicenseState.mockReturnValue('restricted');
    expect(processors.offlineRefusal({ ...base, method: 'cash' })).toBe('license');
  });

  it('a record the store cannot save is reported in catalog text, not the store English', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const { processors } = mountOffline();

    const res = await processors.processCashPayment('tab-1', 9, 10);

    expect(!res.ok && res.error.code).toBe('UNKNOWN_ERROR');
    expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:checkoutSale.offlineSaveFailed'));
    expect(!res.ok && res.error.message).not.toContain('Offline sale');
  });
});
