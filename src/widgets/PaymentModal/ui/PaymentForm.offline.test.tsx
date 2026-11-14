/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
/**
 * PaymentForm offline and re-ring chrome (two-mode Plan 02b, Task 7b): what the pay screen says
 * when the backend is unreachable, on the receipt of a provisional sale, and for a re-ring cart.
 * The eligibility rules are the entity's own (`evaluateOfflineEligibility`), not a copy.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

import type { OfflineRefusalReason } from '@features/checkout-sale/model/offlineReasons';
import {
  evaluateOfflineEligibility,
  useOfflineSaleStore,
  type OfflineEligibilityInput,
} from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { useStaffStore } from '@entities/staff/model/store';
import type { Tab } from '@entities/tab/model/types';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { formatMoney } from '@shared/lib/format';
import i18n from '@shared/lib/i18n';
import type { ReRingMarker } from '@shared/lib/offline-sale-schema';
import type * as PosPrinter from '@shared/lib/pos-printer';
import { openCashDrawer, printReceipt } from '@shared/lib/pos-printer';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';
import { PaymentForm, type PaymentProcessors } from './PaymentForm';
import { reRingDiscountSeed } from './reRingSeed';

const online = vi.hoisted(() => ({ value: true }));
vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOnlineStatus: () => online.value,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, ready: true }),
}));

const manager = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Mock Authorizing Manager',
  email: 'm@test.dev',
  role: 'manager' as const,
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX' as const,
};
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: (props: {
    open: boolean;
    onSuccess: (staff: typeof manager, approvalId: string) => void;
  }) =>
    props.open
      ? createElement(
          'button',
          {
            onClick: () => {
              props.onSuccess(manager, '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f');
            },
          },
          'Grant PIN'
        )
      : null,
}));

vi.mock('@entities/promotion', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePromotions: () => ({ data: [] }),
}));

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return {
    ...actual,
    printReceipt: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
    openCashDrawer: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
  };
});

const mockSettings = {
  billing: {
    taxRatePercent: 0,
    taxInclusive: true,
    paymentMethods: { cash: true, card: true, bank_transfer: true, rappi: true, uber_eats: true },
  },
  paymentLabels: {
    cash: 'Efectivo',
    card: 'Terminal BBVA',
    bank_transfer: 'Transferencia',
    rappi: 'Rappi',
    uber_eats: 'Uber Eats',
  },
  general: { timezone: 'America/Mexico_City' },
};
vi.mock('@entities/settings', () => ({
  useSettings: () => ({ data: mockSettings }),
  useReceiptSettings: () => ({ data: undefined }),
}));

const staffId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const testTab: Tab = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  customerName: 'Test Customer',
  staffId,
  shiftId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  openedAt: new Date('2026-04-17T10:00:00.000Z'),
  closedAt: null,
  status: 'open',
  notes: null,
  orders: [],
  items: [
    {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddd01',
      orderId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      productId: 'ffffffff-ffff-ffff-ffff-fffffffffff1',
      quantity: 2,
      unitPrice: 10,
      modifierIds: [],
      modifierPriceDelta: 0,
      notes: null,
      modifiers: [],
    },
  ],
};

function makeReceipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    receiptNumber: 'R001',
    tabId: testTab.id,
    customerName: testTab.customerName,
    cashierName: 'Staff',
    storeName: 'Test Store',
    barAddress: '1 Main St',
    items: [],
    subtotal: 20,
    total: 20,
    paymentMethod: 'cash',
    processedAt: new Date(),
    squareReceiptUrl: null,
    tenderedAmount: null,
    changeAmount: null,
    ...overrides,
  };
}

const limitState: { value: OfflineEligibilityInput['limit'] } = { value: { ok: true } };
const reRingCart = { value: false };

/** The checkout hook's probe, with the real rules and a fixed set of facts about the till. */
const offlineRefusal: NonNullable<PaymentProcessors['offlineRefusal']> = probe => {
  const result = evaluateOfflineEligibility({
    method: probe.method,
    legs: probe.legs,
    referenceNumber: probe.referenceNumber,
    hasDiscount: probe.hasDiscount,
    hasOverride: probe.hasOverride,
    licenseState: 'active',
    requiresRevalidation: false,
    isCajaOpen: true,
    isReRing: reRingCart.value,
    limit: limitState.value,
  });
  if (result.ok) return null;
  if (result.reason === 'limit' && !limitState.value.ok) {
    return limitState.value.reason === 'count' ? 'limit_count' : 'limit_age';
  }
  return result.reason;
};

function makeProcessors(overrides: Partial<PaymentProcessors> = {}): PaymentProcessors {
  const receipt = makeReceipt();
  return {
    processCashPayment: vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'p-cash', changeAmount: 0, receiptData: receipt })),
    processCardPayment: vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'p-card', receiptData: receipt })),
    processPlatformPayment: vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'p-rappi', receiptData: receipt })),
    processSplitPayment: vi
      .fn()
      .mockResolvedValue(
        ok({ paymentGroupId: 'group-1', paymentIds: ['p-1'], receipts: [receipt] })
      ),
    processBankTransferPayment: vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'p-bt', referenceCode: '1', receiptData: receipt })),
    offlineRefusal,
    canSellOffline: probe => offlineRefusal(probe) === null,
    ...overrides,
  };
}

function renderForm(processors: PaymentProcessors, reRing?: ReRingMarker | null) {
  renderWithProviders(
    <PaymentForm
      tab={testTab}
      staffId={staffId}
      onPaymentSuccess={vi.fn()}
      processors={processors}
      {...(reRing !== undefined ? { reRing } : {})}
    />
  );
}

const MARKER: ReRingMarker = {
  saleId: '11111111-1111-4111-8111-111111111111',
  approvedBy: '77777777-7777-4777-8777-777777777777',
  approvalId: 'approval-1',
  paidTotal: 18,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.billing = { ...mockSettings.billing, taxRatePercent: 0, taxInclusive: true };
  online.value = true;
  limitState.value = { ok: true };
  reRingCart.value = false;
  useOfflineSaleStore.setState({ records: [] });
  useStaffStore.setState({
    currentStaff: {
      id: staffId,
      name: 'Test Manager',
      role: 'manager',
      isActive: true,
      mustChangePin: false,
      locale: 'es-MX',
    },
    currentShift: null,
    staffList: [],
    isAuthenticated: true,
  });
});

afterEach(cleanup);

async function payCash(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('quick-tender-exact'));
  await user.click(screen.getByRole('button', { name: 'Process payment' }));
}

describe('PaymentForm offline', () => {
  it('checkout disables ineligible methods offline with a reason', async () => {
    online.value = false;
    renderForm(makeProcessors());

    for (const id of ['payment-btn-bank-transfer', 'payment-btn-rappi', 'payment-btn-uber-eats']) {
      const button = screen.getByTestId(id);
      expect(button, id).toBeDisabled();
      // the reason is on screen text, tied to the button for assistive tech
      expect(button, id).toHaveAccessibleDescription(/not available offline/i);
    }
    expect(screen.getAllByText(/not available offline/i)).toHaveLength(3);
    expect(screen.getByTestId('payment-btn-cash')).toBeEnabled();
    expect(screen.getByTestId('payment-btn-card')).toBeEnabled();

    // the discount control is disabled with its reason too (Ruling 3)
    const discount = screen.getByRole('switch', { name: 'Discount' });
    expect(discount).toBeDisabled();
    expect(discount).toHaveAccessibleDescription(/discounts need a connection/i);
    expect(screen.getAllByText(/discounts need a connection/i).length).toBeGreaterThan(0);
  });

  it('card offline explains the missing approval reference and waits for it', async () => {
    const user = userEvent.setup();
    online.value = false;
    renderForm(makeProcessors());
    await user.click(screen.getByTestId('payment-btn-card'));

    const pay = screen.getByRole('button', { name: 'Confirm card payment' });
    expect(pay).toBeDisabled();
    expect(screen.getByTestId('offline-reason')).toHaveTextContent(/approval reference/i);
    expect(pay).toHaveAccessibleDescription(/approval reference/i);

    await user.type(screen.getByLabelText(/approval reference/i), 'AUTH-77');
    expect(screen.getByRole('button', { name: 'Confirm card payment' })).toBeEnabled();
    expect(screen.queryByTestId('offline-reason')).not.toBeInTheDocument();
  });

  it('a split offline disables the delivery apps with the split reason', async () => {
    const user = userEvent.setup();
    online.value = false;
    renderForm(makeProcessors());
    await user.click(screen.getByRole('switch', { name: /split payment/i }));

    expect(screen.getAllByTestId('split-payment-btn-rappi')[0]).toBeDisabled();
    expect(screen.getAllByTestId('split-payment-btn-card')[0]).toBeEnabled();
    expect(screen.getAllByText(/split payment offline can only be cash and card/i).length).toBeGreaterThan(0);
  });

  it('a limit refusal from the hook shows the limit message', async () => {
    const user = userEvent.setup();
    online.value = false;
    // the probe said yes a moment ago; the hook answers with the limit
    const processCashPayment = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'NETWORK_OFFLINE', message: 'No internet connection.', details: 'limit_count' },
    });
    renderForm(makeProcessors({ processCashPayment }));
    await payCash(user);

    const message = await screen.findByTestId('offline-limit-message');
    expect(message).toHaveTextContent(/500 offline sales are waiting/i);
    // not the generic "You're offline / try again" dialog
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it("a server refusal's details are never shown as an offline reason", async () => {
    const user = userEvent.setup();
    // a server error whose details string happens to equal a reason
    const processCashPayment = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'Server said no', details: 'limit_count' },
    });
    renderForm(makeProcessors({ processCashPayment }));
    await payCash(user);

    expect(await screen.findByTestId('payment-error-alert')).toHaveTextContent('Server said no');
    expect(screen.queryByTestId('offline-limit-message')).not.toBeInTheDocument();
    expect(screen.queryByTestId('offline-reason')).not.toBeInTheDocument();
    cleanup();

    // and an offline code whose details is a server string is not a reason either
    const processCash2 = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'NETWORK_OFFLINE', message: 'x', details: 'AMOUNT_MISMATCH: moved' },
    });
    renderForm(makeProcessors({ processCashPayment: processCash2 }));
    await payCash(user);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/you're offline/i);
    expect(screen.queryByTestId('offline-reason')).not.toBeInTheDocument();
  });

  it('a failed sell offline after an unknown outcome keeps the unknown outcome warning', async () => {
    const user = userEvent.setup();
    const processCardPayment = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'unknown' },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'UNKNOWN_ERROR',
          message: i18n.t('featOrders:checkoutSale.offlineSaveFailed'),
        },
      });
    renderForm(makeProcessors({ processCardPayment, canSellOffline: () => true }));
    await user.click(screen.getByTestId('payment-btn-card'));
    await user.click(screen.getByRole('button', { name: 'Confirm card payment' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /sell offline instead/i }));

    await waitFor(() => {
      expect(processCardPayment).toHaveBeenCalledTimes(2);
    });
    const again = await screen.findByRole('alertdialog');
    expect(again).toHaveTextContent(/couldn't confirm the payment/i);
    expect(again).toHaveTextContent(/could not be stored on this terminal/i);
    // the online attempt may have gone through: never "nothing was recorded"
    expect(again).not.toHaveTextContent(/nothing was recorded/i);
    expect(screen.queryByTestId('payment-error-alert')).not.toBeInTheDocument();
  });

  it('a refusal reason is cleared when the connection returns', async () => {
    const user = userEvent.setup();
    online.value = false;
    const processCashPayment = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'NETWORK_OFFLINE', message: 'No internet', details: 'limit_count' },
    });
    renderForm(makeProcessors({ processCashPayment }));
    await payCash(user);
    expect(await screen.findByTestId('offline-limit-message')).toBeInTheDocument();

    online.value = true;
    await user.click(screen.getByTestId('amount-keypad-toggle')); // any state change re-renders
    await waitFor(() => {
      expect(screen.queryByTestId('offline-limit-message')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeEnabled();
  });

  it('a refused sell offline keeps the outcome unknown warning', async () => {
    const user = userEvent.setup();
    const processCardPayment = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'unknown' },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'NETWORK_OFFLINE', message: 'No internet', details: 'license' },
      });
    // the probe is stale: it said yes, then the licence moved
    renderForm(makeProcessors({ processCardPayment, canSellOffline: () => true }));
    await user.click(screen.getByTestId('payment-btn-card'));
    await user.click(screen.getByRole('button', { name: 'Confirm card payment' }));

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /sell offline instead/i }));

    await waitFor(() => {
      expect(processCardPayment).toHaveBeenCalledTimes(2);
    });
    const again = await screen.findByRole('alertdialog');
    expect(again).toHaveTextContent(/couldn't confirm the payment/i);
    expect(again).toHaveTextContent(/license doesn't allow selling offline/i);
    expect(again).not.toHaveTextContent(/you're offline/i);

    // cancelling still leaves the warning on the form
    await user.click(within(again).getByRole('button', { name: /cancel/i }));
    expect(await screen.findByText(/couldn't confirm whether the sale was recorded/i)).toBeInTheDocument();
  });
});

describe('PaymentForm provisional receipt step', () => {
  const provisional = makeReceipt({
    receiptNumber: 'P-111111',
    provisional: true,
    provisionalNumber: 'P-111111',
    // buildProvisionalReceipt puts the record id in tabId
    tabId: makeSale().id,
  });
  const confirmedReceipt = makeReceipt({ receiptNumber: 'ABCD1234', tabId: MARKER.saleId });

  async function reachReceipt(user: ReturnType<typeof userEvent.setup>) {
    useOfflineSaleStore.setState({ records: [makeSale()] });
    const processCashPayment = vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'local', changeAmount: 0, receiptData: provisional }));
    renderForm(makeProcessors({ processCashPayment }));
    await payCash(user);
    return screen.findByTestId('provisional-status-chip');
  }

  const settle = (patch: Partial<ReturnType<typeof makeSale>>) => {
    act(() => {
      useOfflineSaleStore.setState({ records: [makeSale(patch)] });
    });
  };

  it('provisional chip flips to confirmed', async () => {
    const user = userEvent.setup();
    const chip = await reachReceipt(user);
    expect(chip).toHaveAttribute('data-state', 'pending');
    expect(chip).toHaveTextContent('Pending confirmation');
    expect(screen.queryByRole('button', { name: 'Print confirmed receipt' })).not.toBeInTheDocument();

    settle({ status: 'confirmed', tabId: MARKER.saleId, confirmedReceipt });

    await waitFor(() => {
      expect(screen.getByTestId('provisional-status-chip')).toHaveAttribute('data-state', 'confirmed');
    });
    expect(screen.getByTestId('provisional-status-chip')).toHaveTextContent('Confirmed');
    expect(screen.getByRole('button', { name: 'Print confirmed receipt' })).toBeInTheDocument();
  });

  it('print confirmed is unavailable with a reason for a slimmed sale', async () => {
    const user = userEvent.setup();
    await reachReceipt(user);

    settle({ status: 'confirmed', tabId: MARKER.saleId, slimmed: true, lines: [] });

    await waitFor(() => {
      expect(screen.getByTestId('provisional-status-chip')).toHaveAttribute('data-state', 'confirmed');
    });
    expect(screen.queryByRole('button', { name: 'Print confirmed receipt' })).not.toBeInTheDocument();
    expect(screen.getByTestId('provisional-print-unavailable')).toHaveTextContent(/reprint it from Payments/i);
  });

  it('a provisional sale that needs review says so on the receipt step', async () => {
    const user = userEvent.setup();
    await reachReceipt(user);

    settle({ status: 'needs_review', lastCode: 'AMOUNT_MISMATCH', attempts: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('provisional-status-chip')).toHaveAttribute('data-state', 'review');
    });
    expect(screen.getByTestId('provisional-status-chip')).toHaveTextContent(/manager will review it/i);
    expect(screen.queryByRole('button', { name: 'Print confirmed receipt' })).not.toBeInTheDocument();
  });

  it('print confirmed receipt prints the server receipt, not the provisional one', async () => {
    const user = userEvent.setup();
    await reachReceipt(user);
    settle({ status: 'confirmed', tabId: MARKER.saleId, confirmedReceipt });
    vi.mocked(printReceipt).mockClear();

    await user.click(await screen.findByRole('button', { name: 'Print confirmed receipt' }));

    await waitFor(() => {
      expect(printReceipt).toHaveBeenCalledTimes(1);
    });
    const [printed] = vi.mocked(printReceipt).mock.calls[0] ?? [];
    expect(printed).toEqual(confirmedReceipt);
    expect((printed as ReceiptData).provisional).toBeUndefined();
  });

  it('the chip follows its own sale when two sales share a provisional number', async () => {
    const user = userEvent.setup();
    const older = makeSale({
      id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'confirmed',
      tabId: MARKER.saleId,
      confirmedReceipt: makeReceipt({ receiptNumber: 'OLDER-SALE', tabId: MARKER.saleId }),
    });
    // same P- number (first six hex chars of the id), another sale: the one on screen
    const own = makeSale({ id: makeSale().id });
    useOfflineSaleStore.setState({ records: [older, own] });
    const processCashPayment = vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'local', changeAmount: 0, receiptData: provisional }));
    renderForm(makeProcessors({ processCashPayment }));
    await payCash(user);

    const chip = await screen.findByTestId('provisional-status-chip');
    expect(chip).toHaveAttribute('data-state', 'pending');
    expect(screen.queryByRole('button', { name: 'Print confirmed receipt' })).not.toBeInTheDocument();

    const ownReceipt = makeReceipt({ receiptNumber: 'OWN-SALE', tabId: MARKER.saleId });
    act(() => {
      useOfflineSaleStore.setState({
        records: [older, { ...own, status: 'confirmed', tabId: MARKER.saleId, confirmedReceipt: ownReceipt }],
      });
    });
    await user.click(await screen.findByRole('button', { name: 'Print confirmed receipt' }));
    const [printed] = vi.mocked(printReceipt).mock.calls.at(-1) ?? [];
    expect((printed as ReceiptData).receiptNumber).toBe('OWN-SALE');
  });

  it('print confirmed is disabled while printing and shows the printer message when it fails', async () => {
    const user = userEvent.setup();
    await reachReceipt(user);
    settle({ status: 'confirmed', tabId: MARKER.saleId, confirmedReceipt });
    type PrintResult = Awaited<ReturnType<typeof printReceipt>>;
    let finish: (v: PrintResult) => void = () => undefined;
    vi.mocked(printReceipt).mockClear();
    vi.mocked(printReceipt).mockReturnValueOnce(
      new Promise<PrintResult>(resolve => {
        finish = resolve;
      })
    );

    const button = await screen.findByRole('button', { name: 'Print confirmed receipt' });
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(printReceipt).toHaveBeenCalledTimes(1);

    finish(err({ code: 'PRINT_JOB_REJECTED', message: 'raw printer text' }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Printer rejected this job. Check the printer name in Settings and try again.'
      );
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Print confirmed receipt' })).toBeEnabled();
    });
  });

  it('a double tap on print confirmed prints once', async () => {
    const user = userEvent.setup();
    await reachReceipt(user);
    settle({ status: 'confirmed', tabId: MARKER.saleId, confirmedReceipt });
    vi.mocked(printReceipt).mockClear();
    const button = await screen.findByRole('button', { name: 'Print confirmed receipt' });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Print confirmed receipt' })).toBeEnabled();
    });
    expect(printReceipt).toHaveBeenCalledTimes(1);
  });

  it('print confirmed can be used again after the first print settles', async () => {
    const user = userEvent.setup();
    await reachReceipt(user);
    settle({ status: 'confirmed', tabId: MARKER.saleId, confirmedReceipt });
    vi.mocked(printReceipt).mockClear();
    await user.click(await screen.findByRole('button', { name: 'Print confirmed receipt' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Print confirmed receipt' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Print confirmed receipt' }));
    expect(printReceipt).toHaveBeenCalledTimes(2);
  });

  it('shows no provisional chip for a normal receipt', async () => {
    const user = userEvent.setup();
    renderForm(makeProcessors());
    await payCash(user);
    await screen.findByRole('heading', { name: 'Receipt' });
    expect(screen.queryByTestId('provisional-status-chip')).not.toBeInTheDocument();
  });
});

describe('PaymentForm re-ring', () => {
  it('a higher price today pre-seeds the fixed discount with the difference', async () => {
    const user = userEvent.setup();
    renderForm(makeProcessors(), MARKER);

    const adjustment = screen.getByTestId('rering-adjustment');
    expect(adjustment).toHaveAttribute('data-kind', 'discount');
    expect(adjustment).toHaveTextContent(`Today's total is higher by ${formatMoney(2)}`);
    // nothing is applied until the manager approves it through the existing discount flow
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(20));
    expect(screen.queryByTestId('discount-row')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    await user.click(screen.getByText(/grant pin/i));

    expect(screen.getByLabelText('Discount amount')).toHaveValue('2.00');
    expect(screen.getByTestId('discount-applied-label')).toHaveTextContent('2.00');
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(18));
    // the suggestion is still "the difference to today's price", not "nothing left"
    expect(screen.getByTestId('rering-adjustment')).toHaveAttribute('data-kind', 'discount');
  });

  it('after the discount is applied the hint shows the applied state, not "turn on"', async () => {
    const user = userEvent.setup();
    renderForm(makeProcessors(), MARKER);
    expect(screen.getByTestId('rering-adjustment')).toHaveTextContent(/turn on discount/i);

    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    await user.click(screen.getByText(/grant pin/i));

    const adjustment = screen.getByTestId('rering-adjustment');
    expect(adjustment).not.toHaveTextContent(/turn on discount/i);
    expect(adjustment).toHaveTextContent(`Discount of ${formatMoney(2)} applied`);
  });

  it('a higher price today pre-seeds a discount that makes the total equal what the customer paid (tax exclusive)', async () => {
    const user = userEvent.setup();
    mockSettings.billing = { ...mockSettings.billing, taxRatePercent: 16, taxInclusive: false };
    // today: 20.00 + 3.20 tax = 23.20; the customer paid 20.88 = 18.00 + 2.88
    renderForm(makeProcessors(), { ...MARKER, paidTotal: 20.88 });

    const adjustment = screen.getByTestId('rering-adjustment');
    expect(adjustment).toHaveTextContent(`Today's total is higher by ${formatMoney(2.32)}`);
    // the hint names the PRE-tax amount that will actually be applied
    expect(adjustment).toHaveTextContent(formatMoney(2));

    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    await user.click(screen.getByText(/grant pin/i));

    expect(screen.getByLabelText('Discount amount')).toHaveValue('2.00');
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(20.88));
  });

  it('when the cents cannot meet exactly it lands just below what was paid and says by how much', async () => {
    const user = userEvent.setup();
    mockSettings.billing = { ...mockSettings.billing, taxRatePercent: 16, taxInclusive: false };
    const paid = 20.84; // no pre-tax amount at 16% totals exactly this
    const seed = reRingDiscountSeed({ base: 20, paid, taxRatePercent: 16, taxInclusive: false });
    expect(seed).not.toBeNull();
    expect(seed?.total ?? paid).toBeLessThan(paid);
    renderForm(makeProcessors(), { ...MARKER, paidTotal: paid });

    expect(screen.getByTestId('rering-adjustment')).toHaveTextContent(
      `${formatMoney(Math.round((paid - (seed?.total ?? 0)) * 100) / 100)} below what the customer paid`
    );
    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    await user.click(screen.getByText(/grant pin/i));
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(seed?.total ?? 0));
  });

  it('turning the discount off removes it from the total and the request', async () => {
    const user = userEvent.setup();
    const processCashPayment = vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'p', changeAmount: 0, receiptData: makeReceipt() }));
    renderForm(makeProcessors({ processCashPayment }));

    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    await user.click(screen.getByText(/grant pin/i));
    await user.click(screen.getByTestId('discount-type-fixed'));
    await user.clear(screen.getByLabelText('Discount amount'));
    await user.type(screen.getByLabelText('Discount amount'), '5');
    await user.tab();
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(15));

    await user.click(screen.getByRole('switch', { name: 'Discount' })); // off
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(20));
    expect(screen.queryByTestId('discount-row')).not.toBeInTheDocument();

    await payCash(user);
    await waitFor(() => {
      expect(processCashPayment).toHaveBeenCalledTimes(1);
    });
    const args = processCashPayment.mock.calls[0] as unknown[];
    expect(args[1]).toBe(20);
    expect(args[3]).toBeUndefined(); // no discountInfo
  });

  it('offline, removing the discount makes the sale payable again', async () => {
    const user = userEvent.setup();
    renderForm(makeProcessors());
    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    await user.click(screen.getByText(/grant pin/i));
    await user.click(screen.getByTestId('discount-type-fixed'));
    await user.type(screen.getByLabelText('Discount amount'), '5');
    await user.tab();

    online.value = false;
    await user.click(screen.getByTestId('quick-tender-exact')); // re-render offline
    expect(screen.getByTestId('offline-reason')).toHaveAttribute('data-reason', 'discount');
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: 'Discount' })); // off: the way out
    expect(screen.queryByTestId('offline-reason')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('quick-tender-exact'));
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeEnabled();
  });

  it('a re-ring discount that is switched off is not sent', async () => {
    const user = userEvent.setup();
    const processCashPayment = vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'p', changeAmount: 0, receiptData: makeReceipt() }));
    renderForm(makeProcessors({ processCashPayment }), MARKER);

    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    await user.click(screen.getByText(/grant pin/i));
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(18));

    await user.click(screen.getByRole('switch', { name: 'Discount' })); // off
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(20));
    await payCash(user);
    await waitFor(() => {
      expect(processCashPayment).toHaveBeenCalledTimes(1);
    });
    expect((processCashPayment.mock.calls[0] as unknown[])[3]).toBeUndefined();
  });

  it('a lower price today shows what the customer overpaid and seeds nothing', async () => {
    const user = userEvent.setup();
    renderForm(makeProcessors(), { ...MARKER, paidTotal: 25 });

    const adjustment = screen.getByTestId('rering-adjustment');
    expect(adjustment).toHaveAttribute('data-kind', 'overpaid');
    expect(adjustment).toHaveTextContent(`Customer paid ${formatMoney(5)} more than today's total`);

    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    await user.click(screen.getByText(/grant pin/i));
    expect(screen.getByLabelText('Discount %')).toHaveValue('0.00');
    expect(screen.queryByTestId('discount-row')).not.toBeInTheDocument();
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(20));
  });

  it('an equal price shows no difference', () => {
    renderForm(makeProcessors(), { ...MARKER, paidTotal: 20 });
    expect(screen.getByTestId('rering-adjustment')).toHaveAttribute('data-kind', 'none');
  });

  it('sell offline instead is never offered for a re-ring cart', async () => {
    const user = userEvent.setup();
    reRingCart.value = true;
    const processCardPayment = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'unknown' },
    });
    renderForm(
      makeProcessors({ processCardPayment, canSellOffline: probe => offlineRefusal(probe) === null }),
      MARKER
    );
    await user.click(screen.getByTestId('payment-btn-card'));
    await user.click(screen.getByRole('button', { name: 'Confirm card payment' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('button', { name: /sell offline instead/i })).not.toBeInTheDocument();
  });

  it('online checkout shows no offline or re-ring chrome', () => {
    renderForm(makeProcessors());
    expect(screen.queryByTestId('rering-adjustment')).not.toBeInTheDocument();
    expect(screen.queryByTestId('offline-reason')).not.toBeInTheDocument();
    expect(screen.queryByTestId('offline-limit-message')).not.toBeInTheDocument();
    expect(screen.queryByTestId('offline-method-reasons')).not.toBeInTheDocument();
    for (const id of ['payment-btn-bank-transfer', 'payment-btn-rappi', 'payment-btn-uber-eats']) {
      expect(screen.getByTestId(id)).toBeEnabled();
    }
    expect(screen.getByRole('switch', { name: 'Discount' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Discount' })).not.toHaveAccessibleDescription(
      /need a connection/i
    );
  });
});

const MESSAGES: Partial<Record<OfflineRefusalReason, string>> = {
  license: "This terminal's license doesn't allow selling offline right now.",
  revalidation:
    'This terminal has been offline too long, or its saved prices are out of date. Reconnect so it can be verified before selling.',
  no_open_caja:
    'Selling offline needs the register and your shift already open. Open them while online.',
  rering: 'A re-ring has to be completed online. Reconnect to finish it.',
};

describe('PaymentForm offline reasons by reason', () => {
  const reasons: OfflineRefusalReason[] = ['license', 'revalidation', 'no_open_caja', 'rering'];
  it.each(reasons)('a till-wide refusal (%s) blocks the pay action with its message', reason => {
    online.value = false;
    renderForm(makeProcessors({ offlineRefusal: () => reason, canSellOffline: () => false }));
    const message = screen.getByTestId('offline-reason');
    expect(message).toHaveAttribute('data-reason', reason);
    // the words, not just the box: an untranslated key or an empty string fails here
    expect(message.textContent ?? '').toBe(MESSAGES[reason]);
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeDisabled();
  });
});

describe('PaymentForm double tap', () => {
  it('a double tap on pay runs the payment and its success side effects once', async () => {
    const user = userEvent.setup();
    online.value = false;
    const processCashPayment = vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'local', changeAmount: 0, receiptData: makeReceipt() }));
    const onPaymentSuccess = vi.fn();
    renderWithProviders(
      <PaymentForm
        tab={testTab}
        staffId={staffId}
        onPaymentSuccess={onPaymentSuccess}
        processors={makeProcessors({ processCashPayment })}
      />
    );
    await user.click(screen.getByTestId('quick-tender-exact'));
    const pay = screen.getByRole('button', { name: 'Process payment' });

    act(() => {
      fireEvent.click(pay);
      fireEvent.click(pay);
    });

    await screen.findByRole('heading', { name: 'Receipt' });
    await waitFor(() => {
      expect(printReceipt).toHaveBeenCalledTimes(1);
    });
    expect(processCashPayment).toHaveBeenCalledTimes(1);
    expect(onPaymentSuccess).toHaveBeenCalledTimes(1);
    expect(openCashDrawer).toHaveBeenCalledTimes(1);
  });

  it('the form is usable again after a processor rejects', async () => {
    const user = userEvent.setup();
    const processCashPayment = vi
      .fn()
      .mockRejectedValueOnce(new Error('processor blew up'))
      .mockResolvedValue(ok({ paymentId: 'p', changeAmount: 0, receiptData: makeReceipt() }));
    const onPaymentSuccess = vi.fn();
    renderWithProviders(
      <PaymentForm
        tab={testTab}
        staffId={staffId}
        onPaymentSuccess={onPaymentSuccess}
        onClose={vi.fn()}
        processors={makeProcessors({ processCashPayment })}
      />
    );
    await payCash(user);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Process payment' })).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
    expect(onPaymentSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      i18n.t('featOrders:checkoutSale.outcomeUnknown')
    );
    expect(screen.queryByText(/processor blew up/)).not.toBeInTheDocument();
    expect(printReceipt).not.toHaveBeenCalled();
    expect(openCashDrawer).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Process payment' }));
    await screen.findByRole('heading', { name: 'Receipt' });
    expect(processCashPayment).toHaveBeenCalledTimes(2);
    expect(onPaymentSuccess).toHaveBeenCalledTimes(1);
  });
});
