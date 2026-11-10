/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOfflineSaleStore } from '@entities/offline-sale';
import type * as OfflineSaleEntity from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { CajaSession, Product, Shift, Staff } from '@shared/lib/domain';
import type * as EdgeContracts from '@shared/lib/edge-function-contracts';
import i18n from '@shared/lib/i18n';
import type * as LicenseStore from '@shared/lib/license/store';
import { err, ok } from '@shared/lib/result';

import { useCheckoutSale } from './useCheckoutSale';

// ---------------------------------------------------------------------------
// The REAL cart store, offline-sale store and eligibility rules: a re-ring is a
// cart marker plus a stored record, and the interesting failures are the ones
// between them (reload, lost response, storage). Only the network, the signed-in
// session and the clock are stubbed.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-09T12:00:00.000Z');

vi.mock('@entities/staff', () => ({
  useStaffStore: (
    selector: (state: { currentStaff: Staff | null; currentShift: Shift | null }) => unknown
  ) => selector({ currentStaff: staff, currentShift: shift }),
}));

vi.mock('@entities/caja', () => ({
  useCajaStore: (
    selector: (state: { currentCaja: CajaSession | null; isCajaOpen: boolean }) => unknown
  ) => selector({ currentCaja: caja, isCajaOpen: true }),
}));

const completeSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
// Test-only switch: lets a marked cart down the provisional path, which the real rules forbid.
const bypass = vi.hoisted(() => ({ eligibility: false }));
vi.mock('@entities/offline-sale', async importOriginal => {
  const actual = await importOriginal<typeof OfflineSaleEntity>();
  return {
    ...actual,
    evaluateOfflineEligibility: (...args: Parameters<typeof actual.evaluateOfflineEligibility>) =>
      bypass.eligibility ? { ok: true as const } : actual.evaluateOfflineEligibility(...args),
    completeReRing: (...args: Parameters<typeof actual.completeReRing>) => {
      completeSpy.calls.push(args);
      return actual.completeReRing(...args);
    },
  };
});

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@shared/lib/supabase', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@shared/lib/logger-instance', () => ({ logger: log }));

const mockCallProcessDirectSale = vi.fn();
vi.mock('@shared/lib/edge-function-contracts', async importOriginal => ({
  ...(await importOriginal<typeof EdgeContracts>()),
  callProcessDirectSale: (request: unknown) =>
    (mockCallProcessDirectSale as (r: unknown) => unknown)(request),
}));

const mockIsOnline = vi.fn(() => true);
vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isOnline: () => mockIsOnline(),
}));

vi.mock('@shared/lib/license/store', async importOriginal => ({
  ...(await importOriginal<typeof LicenseStore>()),
  requiresRevalidation: () => false,
  currentLicenseEvaluation: () => ({ state: 'active' }),
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

const CATEGORY = '66666666-6666-4666-8666-666666666666';
const product: Product = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Basmati rice 1kg',
  categoryId: CATEGORY,
  category: {
    id: CATEGORY,
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

const SALE = '11111111-1111-4111-8111-111111111111';
const NEW_TAB = '77777777-7777-4777-8777-777777777778';
const MANAGER = '88888888-8888-4888-8888-888888888889';
const APPROVAL = '5f1e2d3c-4b5a-4c6d-8e7f-000000000009';
const STORAGE_KEY = 'direct-sale-held-cart';
const marker = { saleId: SALE, approvedBy: MANAGER, approvalId: APPROVAL, paidTotal: 9 };

const cart = () => useCartStore.getState();
const record = () => {
  const [first] = useOfflineSaleStore.getState().records;
  if (!first) throw new Error('no record');
  return first;
};

/** The cart `reRing` leaves behind: today's items plus the marker. */
function fillReRingCart() {
  cart().addItem(product, []);
  cart().addItem(product, []);
  cart().setReRing(marker);
}

const serverReply = (total = 9, idempotent = false) =>
  ok({
    tabId: NEW_TAB,
    paymentId: '99999999-9999-4999-8999-999999999990',
    idempotent,
    receiptData: { total, tabId: NEW_TAB, changeAmount: 1 },
  });

const pay = (hook: ReturnType<typeof mount>) =>
  act(async () => hook.result.current.processors.processCashPayment('tab', 9, 10));

const mount = () => renderHook(() => useCheckoutSale());

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  completeSpy.calls.length = 0;
  bypass.eligibility = false;
  mockIsOnline.mockReturnValue(true);
  rpc.mockResolvedValue({ data: 'audit-id', error: null });
  mockCallProcessDirectSale.mockResolvedValue(serverReply());
  useCartStore.setState({
    items: [],
    heldCart: null,
    comboResult: null,
    pendingIdempotencyKey: null,
    pendingIdempotencyFingerprint: null,
    reRing: null,
    submission: null,
  });
  useOfflineSaleStore.setState({
    records: [makeSale({ id: SALE, status: 'needs_review', lastCode: 'AMOUNT_MISMATCH', attempts: 1 })],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('re-ring checkout', () => {
  it('a re-ring cart is not paid while the lost-answer flag is set', async () => {
    fillReRingCart();
    useOfflineSaleStore.setState({
      records: [makeSale({ id: SALE, status: 'needs_review', lastCode: 'AMOUNT_MISMATCH', attempts: 1, resolutionOutcomeUnknown: true })],
    });
    const res = await pay(mount());
    expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(!res.ok && res.error.message).toBe(i18n.t('featOrders:reviewOfflineSales.reRingAfterLostWriteOff'));
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
    expect(cart().pendingIdempotencyKey).toBeNull();
  });

  describe('the cart must hold the goods that were sold', () => {
    const OTHER: Product = { ...product, id: '44444444-4444-4444-8444-444444444444', name: 'Toor dal 1kg' };
    // New goods first, then the original lines: emptying the cart would drop the marker (abandon).
    const replaceLines = (...next: Product[]) => {
      const original = cart().items.map(line => line.tempId);
      for (const p of next) cart().addItem(p, []);
      for (const tempId of original) cart().removeItem(tempId);
      expect(cart().reRing).toEqual(marker);
    };
    const expectRefusedUntouched = async (hook: ReturnType<typeof mount>) => {
      const res = await pay(hook);
      expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(!res.ok && res.error.message).toBeTruthy();
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
      // cart, marker and key untouched: the cashier can restore the lines or clear the cart
      expect(cart().reRing).toEqual(marker);
      expect(cart().pendingIdempotencyKey).toBeNull();
      expect(record().status).toBe('needs_review');
    };

    it('a re-ring cart whose goods were changed cannot be paid', async () => {
      fillReRingCart();
      // the next customer's basket, same total (2 x 4.50)
      replaceLines(OTHER, OTHER);
      await expectRefusedUntouched(mount());
    });

    it('a re-ring cart with a line removed cannot be paid', async () => {
      fillReRingCart();
      const [first] = cart().items;
      if (!first) throw new Error('no line');
      cart().updateQuantity(first.tempId, -1);
      await expectRefusedUntouched(mount());
    });

    it('a re-ring cart with the same goods at different prices can be paid', async () => {
      fillReRingCart();
      // today's catalog price: the same lines, repriced
      useCartStore.setState({
        items: cart().items.map(line => ({
          ...line,
          unitPrice: 5.25,
          lineTotal: 5.25 * line.quantity,
          product: { ...line.product, basePrice: 5.25 },
        })),
      });
      const res = await pay(mount());
      expect(res.ok).toBe(true);
      expect(record()).toMatchObject({ status: 'resolved', resolution: 'rering', linkedTabId: NEW_TAB });
    });

    it('a re-ring whose record is no longer in review cannot be paid', async () => {
      fillReRingCart();
      useOfflineSaleStore.setState({ records: [makeSale({ id: SALE, status: 'confirmed' })] });
      const hook = mount();
      const res = await pay(hook);
      expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
      expect(cart().reRing).toEqual(marker);
      expect(cart().pendingIdempotencyKey).toBeNull();

      // and a record that is gone altogether
      useOfflineSaleStore.setState({ records: [] });
      const gone = await pay(hook);
      expect(gone).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
    });
  });

  it("a re-ring cart's key starts with rering_ and the sale id; a normal cart's key is unchanged", async () => {
    fillReRingCart();
    await pay(mount());
    const reRingKey = (mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string }).idempotencyKey;
    // the server recognises a paid re-ring by this prefix (Ruling 9): rering_<offline sale id>_<time>_<random>
    expect(reRingKey).toMatch(new RegExp(`^rering_${SALE}_\\d+_[0-9a-f]{8}$`));
    expect(record().reRingAttemptKeys).toEqual([reRingKey]);

    // an ordinary cart (no marker) keeps the direct_sale prefix
    mockCallProcessDirectSale.mockClear();
    useCartStore.getState().clearCart();
    useCartStore.getState().addItem(product, []);
    await pay(mount());
    const plain = (mockCallProcessDirectSale.mock.calls[0]?.[0] as { idempotencyKey: string }).idempotencyKey;
    expect(plain).toMatch(/^direct_sale_\d+_[0-9a-f]{8}$/);
  });

  it('a re-ring cart with a pending key that lacks the sale prefix mints a new prefixed key', async () => {
    fillReRingCart();
    mockCallProcessDirectSale.mockResolvedValueOnce(err({ code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'unknown' }));
    const hook = mount();
    await pay(hook);
    // the recovery screen resolved the marker (30-review H2 refuses a different key while one is open)
    useCartStore.setState({ pendingIdempotencyKey: 'direct_sale_stale', submission: null });
    useCartStore.setState({ pendingIdempotencyKey: 'direct_sale_stale' });
    mockCallProcessDirectSale.mockResolvedValueOnce(serverReply(9, true));

    await pay(hook);

    const second = (mockCallProcessDirectSale.mock.calls[1]?.[0] as { idempotencyKey: string }).idempotencyKey;
    expect(second).toMatch(new RegExp(`^rering_${SALE}_\\d+_[0-9a-f]{8}$`));
  });

  it('a re-rung sale completes the record when the checkout succeeds', async () => {
    fillReRingCart();
    const originalKey = record().request.idempotencyKey;
    const hook = mount();

    const res = await pay(hook);

    expect(res.ok).toBe(true);
    // a fresh key: the original sale's key is never sent again
    const sent = (mockCallProcessDirectSale.mock.calls[0]?.[0] ?? {}) as { idempotencyKey: string };
    expect(sent.idempotencyKey).not.toBe(originalKey);
    expect(sent.idempotencyKey).toBeTruthy();
    expect(completeSpy.calls).toEqual([[marker, NEW_TAB, 9]]);
    expect(record()).toMatchObject({
      status: 'resolved',
      resolution: 'rering',
      linkedTabId: NEW_TAB,
      resolvedBy: MANAGER,
    });
    expect(hook.result.current.reRingCompletionError).toBeNull();
  });

  it('records what the customer overpaid when the new sale costs less', async () => {
    fillReRingCart();
    mockCallProcessDirectSale.mockResolvedValue(serverReply(8));
    await pay(mount());
    expect(record()).toMatchObject({ resolution: 'rering', customerOverpaid: 1 });
  });

  it('a re-ring survives a reload and still completes', async () => {
    fillReRingCart();
    // what a restart does: memory is gone, storage is not
    const saved = localStorage.getItem(STORAGE_KEY);
    expect(saved).toContain(SALE);
    useCartStore.setState({ items: [], reRing: null });
    localStorage.setItem(STORAGE_KEY, saved ?? '');
    await useCartStore.persist.rehydrate();
    expect(cart().reRing).toEqual(marker);
    expect(cart().items.map(i => i.quantity)).toEqual([2]);

    const res = await pay(mount());

    expect(res.ok).toBe(true);
    expect(record()).toMatchObject({ status: 'resolved', resolution: 'rering', linkedTabId: NEW_TAB });
  });

  it('a lost response is retried with the same key and then completes the record', async () => {
    fillReRingCart();
    mockCallProcessDirectSale.mockResolvedValueOnce(
      err({ code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'unknown' })
    );
    const hook = mount();

    const first = await pay(hook);
    expect(first.ok).toBe(false);
    expect(record().status).toBe('needs_review');
    expect(cart().reRing).toEqual(marker);

    mockCallProcessDirectSale.mockResolvedValueOnce(serverReply(9, true));
    const second = await pay(hook);

    expect(second.ok).toBe(true);
    const keys = mockCallProcessDirectSale.mock.calls.map(
      ([req]) => (req as { idempotencyKey: string }).idempotencyKey
    );
    expect(keys[0]).toBe(keys[1]);
    expect(record()).toMatchObject({ status: 'resolved', linkedTabId: NEW_TAB });
  });

  describe('re-ring attempt keys (D13)', () => {
    it('a re-ring attempt key is stored on the record before the request is sent', async () => {
      fillReRingCart();
      let storedAtSend: string[] | undefined;
      let sentKey: string | undefined;
      mockCallProcessDirectSale.mockImplementation((req: { idempotencyKey: string }) => {
        sentKey = req.idempotencyKey;
        storedAtSend = [...record().reRingAttemptKeys];
        return Promise.resolve(serverReply());
      });

      const res = await pay(mount());

      expect(res.ok).toBe(true);
      expect(sentKey).toBeTruthy();
      expect(storedAtSend).toEqual([sentKey]);
      // and it is on disk, not only in memory
      expect(localStorage.getItem('offline-sales')).toContain(sentKey);
    });

    it('a re-ring payment is not sent when its key cannot be persisted', async () => {
      fillReRingCart();
      const setItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
        if (key === 'offline-sales') throw new DOMException('quota', 'QuotaExceededError');
        setItem(key, value);
      });

      const res = await pay(mount());

      expect(res).toMatchObject({ ok: false, error: { code: 'UNKNOWN_ERROR' } });
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
      expect(record().reRingAttemptKeys).toEqual([]);
      expect(record().status).toBe('needs_review');
    });
  });

  describe('a re-ring that already completed (reload before Done)', () => {
    const OLD_COPY = () => i18n.t('featOrders:reviewOfflineSales.reRingCartChanged');
    const NEW_COPY = () => i18n.t('featOrders:reviewOfflineSales.reRingAlreadyCompleted');
    /** Pay the re-ring, then do what a restart does: memory gone, storage kept. */
    const payThenReload = async () => {
      fillReRingCart();
      const first = await pay(mount());
      expect(first.ok).toBe(true);
      const saved = localStorage.getItem(STORAGE_KEY);
      useCartStore.setState({ items: [], reRing: null, pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null });
      localStorage.setItem(STORAGE_KEY, saved ?? '');
      await useCartStore.persist.rehydrate();
      expect(cart().reRing).toEqual(marker);
      // the recovery screen has resolved the persisted submission marker before Pay can be reached again
      cart().clearSubmission();
    };

    it('re-paying a completed re-ring after a reload replays under the same key and succeeds once', async () => {
      await payThenReload();
      const completed = record();
      expect(cart().pendingIdempotencyKey).toBeTruthy();
      rpc.mockClear();
      mockCallProcessDirectSale.mockResolvedValue(serverReply(9, true));

      const res = await pay(mount());

      expect(res.ok).toBe(true);
      expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(2);
      const keys = mockCallProcessDirectSale.mock.calls.map(
        ([req]) => (req as { idempotencyKey: string }).idempotencyKey
      );
      expect(keys[1]).toBe(keys[0]);
      expect(record()).toEqual(completed);
      expect(record()).toMatchObject({ status: 'resolved', resolution: 'rering', linkedTabId: NEW_TAB });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('the replay of a completed re-ring requires the pending key to be a recorded attempt key', async () => {
      await payThenReload();
      // the record names the attempt that paid; the cart carries some other attempt's key
      expect(record().reRingAttemptKeys).toEqual([cart().pendingIdempotencyKey]);
      useCartStore.setState({ pendingIdempotencyKey: 'direct_sale_someone_elses_attempt' });
      mockCallProcessDirectSale.mockClear();

      const res = await pay(mount());

      expect(!res.ok && res.error.message).toBe(NEW_COPY());
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
    });

    it('the replay of a completed re-ring refuses when it would send a different key', async () => {
      await payThenReload();
      // a pre-02c or tampered state: the pending key is not this re-ring's, whether or not the record names it
      for (const recorded of [[], ['direct_sale_stale']]) {
        useOfflineSaleStore.setState({ records: [{ ...record(), reRingAttemptKeys: recorded }] });
        useCartStore.setState({ pendingIdempotencyKey: 'direct_sale_stale' });
        mockCallProcessDirectSale.mockClear();

        const res = await pay(mount());

        expect(!res.ok && res.error.message).toBe(NEW_COPY());
        expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
      }
    });

    it('a completed re-ring recorded before attempt keys existed still replays', async () => {
      await payThenReload();
      useOfflineSaleStore.setState({ records: [{ ...record(), reRingAttemptKeys: [] }] });
      mockCallProcessDirectSale.mockClear();
      mockCallProcessDirectSale.mockResolvedValue(serverReply(9, true));

      const res = await pay(mount());

      expect(res.ok).toBe(true);
      expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(1);
    });

    it('a completed re-ring re-paid with a different discount is refused and sends nothing', async () => {
      await payThenReload();
      const pendingKey = cart().pendingIdempotencyKey;
      expect(pendingKey).toBeTruthy();
      mockCallProcessDirectSale.mockClear();

      // the first attempt carried no discount: a different one is a different sale
      const hook = mount();
      const res = await act(async () =>
        hook.result.current.processors.processCashPayment('tab', 8, 10, {
          scope: 'all',
          type: 'fixed',
          value: 1,
          amount: 1,
          managerOverride: false,
          approvalId: undefined,
          approverId: undefined,
        })
      );

      expect(!res.ok && res.error.message).toBe(NEW_COPY());
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
      expect(cart().pendingIdempotencyKey).toBe(pendingKey);
    });

    it.each([
      ['PAYMENT_FAILED', { code: 'SUPABASE_ERROR', details: 'PAYMENT_FAILED: tender shape differs' }],
      ['IDEMPOTENCY_UNAUTHORIZED', { code: 'SUPABASE_ERROR', details: 'IDEMPOTENCY_UNAUTHORIZED: other cashier' }],
      ['SHIFT_NOT_OPEN', { code: 'AUTH_FORBIDDEN', details: 'SHIFT_NOT_OPEN: no shift' }],
      ['CAJA_CLOSED', { code: 'CAJA_CLOSED', details: 'CAJA_CLOSED: caja closed' }],
    ] as const)(
      'a refused replay of a completed re-ring reads as already completed, not as a failed payment (%s)',
      async (_name, refusal) => {
        await payThenReload();
        mockCallProcessDirectSale.mockClear();
        mockCallProcessDirectSale.mockResolvedValue(err({ ...refusal, message: 'server text' }));

        const res = await pay(mount());

        expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(1);
        expect(!res.ok && res.error.message).toBe(NEW_COPY());
        expect(record()).toMatchObject({ status: 'resolved', linkedTabId: NEW_TAB });
      }
    );

    it('an unreachable replay of a completed re-ring keeps the outcome-unknown handling', async () => {
      await payThenReload();
      mockCallProcessDirectSale.mockClear();
      mockCallProcessDirectSale.mockResolvedValue(err({ code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'unknown' }));

      const res = await pay(mount());

      expect(res).toMatchObject({ ok: false, error: { code: 'PAYMENT_OUTCOME_UNKNOWN' } });
      expect(!res.ok && res.error.message).not.toBe(NEW_COPY());
    });

    it('a completed re-ring with no pending key is refused with the already-completed copy', async () => {
      await payThenReload();
      useCartStore.setState({ pendingIdempotencyKey: null, pendingIdempotencyFingerprint: null });
      mockCallProcessDirectSale.mockClear();

      const res = await pay(mount());

      expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(!res.ok && res.error.message).toBe(NEW_COPY());
      expect(!res.ok && res.error.message).not.toBe(OLD_COPY());
      expect(NEW_COPY()).not.toBe('featOrders:reviewOfflineSales.reRingAlreadyCompleted');
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
    });

    it('a re-ring cart whose goods no longer match is still refused after completion', async () => {
      await payThenReload();
      mockCallProcessDirectSale.mockClear();
      const other: Product = { ...product, id: '44444444-4444-4444-8444-444444444444', name: 'Toor dal 1kg' };
      const original = cart().items.map(line => line.tempId);
      cart().addItem(other, []);
      for (const tempId of original) cart().removeItem(tempId);

      const res = await pay(mount());

      expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
      expect(record()).toMatchObject({ status: 'resolved', linkedTabId: NEW_TAB });
    });

    it.each(['queued', 'replaying', 'confirmed', 'missing'] as const)(
      'a re-ring cart linked to a record in %s status is still refused',
      async status => {
        fillReRingCart();
        useOfflineSaleStore.setState({
          records: status === 'missing' ? [] : [makeSale({ id: SALE, status })],
        });
        const res = await pay(mount());
        expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
        expect(!res.ok && res.error.message).toBe(OLD_COPY());
        expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
      }
    );

    it('a re-ring cart linked to a record resolved another way is still refused', async () => {
      fillReRingCart();
      useOfflineSaleStore.setState({
        records: [makeSale({ id: SALE, status: 'resolved', resolution: 'written_off' })],
      });
      const res = await pay(mount());
      expect(!res.ok && res.error.message).toBe(OLD_COPY());
      expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
    });
  });

  it('a refused re-ring sale leaves the record in review', async () => {
    fillReRingCart();
    mockCallProcessDirectSale.mockResolvedValue(err({ code: 'PAYMENT_DECLINED', message: 'no' }));
    const res = await pay(mount());
    expect(res.ok).toBe(false);
    expect(record().status).toBe('needs_review');
    expect(completeSpy.calls).toHaveLength(0);
  });

  it.each(['OFFLINE_SALE_WRITTEN_OFF', 'OFFLINE_SALE_ALREADY_CLOSED', 'RERING_ALREADY_PAID', 'RERING_NOT_APPROVED'])(
    'a re-ring refused with either code leaves the offline record in review and sends no second request (%s)',
    async code => {
      fillReRingCart();
      mockCallProcessDirectSale.mockResolvedValue(
        err({ code: 'VALIDATION_ERROR', message: 'copy', details: `${code}: server wording` })
      );
      const res = await pay(mount());
      expect(res).toMatchObject({ ok: false, error: { details: `${code}: server wording` } });
      expect(mockCallProcessDirectSale).toHaveBeenCalledTimes(1);
      expect(record().status).toBe('needs_review');
      expect(completeSpy.calls).toHaveLength(0);
      // a write-off or a link the server holds closes Retry and Re-ring (only Write off remains); a missing approval does not
      expect(record().resolutionOutcomeUnknown).toBe(code !== 'RERING_NOT_APPROVED');
    }
  );

  it('a re-ring cannot be sold offline', async () => {
    fillReRingCart();
    const hook = mount();
    const probe = { method: 'cash' as const, hasDiscount: false, hasOverride: false };

    // reachable backend: the "Sell offline instead" probe and a forced offline sale both refuse
    expect(hook.result.current.processors.canSellOffline(probe)).toBe(false);
    const forced = await act(async () =>
      hook.result.current.processors.processCashPayment('tab', 9, 10, undefined, undefined, undefined, {
        sellOffline: true,
      })
    );
    expect(forced).toMatchObject({ ok: false, error: { code: 'NETWORK_OFFLINE', details: 'rering' } });

    // no backend: the same
    mockIsOnline.mockReturnValue(false);
    const offline = await pay(hook);
    expect(offline).toMatchObject({ ok: false, error: { code: 'NETWORK_OFFLINE', details: 'rering' } });

    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
    expect(useOfflineSaleStore.getState().records).toHaveLength(1);
    expect(record().status).toBe('needs_review');
  });

  it('an offline provisional result never completes a re-ring', async () => {
    // Eligibility refuses a marked cart offline, so force the provisional path: even then the
    // stored provisional sale must leave the record in review alone.
    fillReRingCart();
    bypass.eligibility = true;
    mockIsOnline.mockReturnValue(false);

    const res = await pay(mount());

    expect(res.ok).toBe(true);
    expect(useOfflineSaleStore.getState().records).toHaveLength(2);
    expect(mockCallProcessDirectSale).not.toHaveBeenCalled();
    expect(completeSpy.calls).toHaveLength(0);
    expect(record()).toMatchObject({ id: SALE, status: 'needs_review' });
  });

  it('a completion that cannot be stored reports the new sale and does not fail the checkout', async () => {
    fillReRingCart();
    // only the completion write fails (the attempt key was stored before the request); the cart store keeps persisting
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === 'offline-sales' && value.includes('"status":"resolved"')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      setItem(key, value);
    });
    const hook = mount();

    const res = await pay(hook);

    expect(res.ok).toBe(true);
    expect(res.ok && res.data.receiptData).toMatchObject({ tabId: NEW_TAB });
    const failure = hook.result.current.reRingCompletionError;
    expect(failure?.message).toContain(NEW_TAB.slice(0, 8));
    expect(record().status).toBe('needs_review');
    expect(log.error).toHaveBeenCalled();
    // the link is still audited, unlinked, so /audit holds it after a restart
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalled();
    });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_action: 'offline_sale_resolved',
      p_entity_id: NEW_TAB,
      p_after: { resolution: 'rering', linked: false, linkedTabId: NEW_TAB, approvalId: APPROVAL },
    });
  });

  it('a re-ring completes even if the cart was cleared while the payment was in flight', async () => {
    fillReRingCart();
    let answer: (v: unknown) => void = () => undefined;
    mockCallProcessDirectSale.mockReturnValueOnce(new Promise(resolve => {
        answer = resolve;
      }));
    const hook = mount();

    const pending = hook.result.current.processors.processCashPayment('tab', 9, 10);
    cart().clearCart();
    expect(cart().reRing).toBeNull();
    await act(async () => {
      answer(serverReply());
      await pending;
    });

    expect(completeSpy.calls).toEqual([[marker, NEW_TAB, 9]]);
    expect(record()).toMatchObject({ status: 'resolved', resolution: 'rering', linkedTabId: NEW_TAB });
  });

  it('an ordinary sale in flight never completes a re-ring filled meanwhile', async () => {
    cart().addItem(product, []);
    let answer: (v: unknown) => void = () => undefined;
    mockCallProcessDirectSale.mockReturnValueOnce(new Promise(resolve => {
        answer = resolve;
      }));
    const hook = mount();

    const pending = hook.result.current.processors.processCashPayment('tab', 4.5, 5);
    // the ordinary cart is abandoned and a manager fills a re-ring while the answer is on its way
    cart().clearCart();
    fillReRingCart();
    await act(async () => {
      answer(serverReply(4.5));
      await pending;
    });

    expect(completeSpy.calls).toHaveLength(0);
    expect(record().status).toBe('needs_review');
    expect(cart().reRing).toEqual(marker);
  });

  it('completion returns before the audit call settles', async () => {
    fillReRingCart();
    rpc.mockReturnValue(new Promise(() => undefined));

    const res = await pay(mount());

    expect(res.ok).toBe(true);
    expect(record()).toMatchObject({ status: 'resolved', resolution: 'rering' });
  });

  it('a completion error does not linger on the next ordinary sale', async () => {
    fillReRingCart();
    const setItem = localStorage.setItem.bind(localStorage);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === 'offline-sales' && value.includes('"status":"resolved"')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      setItem(key, value);
    });
    const hook = mount();
    await pay(hook);
    expect(hook.result.current.reRingCompletionError).not.toBeNull();
    spy.mockRestore();

    cart().clearCart();
    cart().addItem(product, []);
    await act(async () => hook.result.current.processors.processCashPayment('tab', 4.5, 5));

    expect(hook.result.current.reRingCompletionError).toBeNull();
  });

  it('the online checkout of an ordinary cart is unchanged', async () => {
    cart().addItem(product, []);
    cart().addItem(product, []);
    const hook = mount();

    const res = await pay(hook);

    expect(res.ok).toBe(true);
    expect(completeSpy.calls).toHaveLength(0);
    expect(record().status).toBe('needs_review');
    expect(hook.result.current.reRingCompletionError).toBeNull();
    const sent = (mockCallProcessDirectSale.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(
      [
        'amount',
        'cajaSessionId',
        'idempotencyKey',
        'items',
        'method',
        'shiftId',
        'tenderedAmount',
        'terminalId',
      ].sort()
    );
  });
});
