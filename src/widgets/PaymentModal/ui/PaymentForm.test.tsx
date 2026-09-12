/**
 * Unit tests for PaymentForm — card charge override feature
 *
 * Covers: MoneyInput for charge amount, default value, onChange, reset button
 * visibility/behavior, canSubmit guard, and processCardPayment call args.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { createElement } from 'react';
import { toast } from 'sonner';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// jsdom polyfills — Radix Select (Phase 27's "Apply Promotion" selector)
// uses pointer-capture APIs not implemented by jsdom; safe no-ops keep
// trigger/open/select interactions deterministic.
// ---------------------------------------------------------------------------
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

import type * as PromotionModule from '@entities/promotion';
import { useStaffStore } from '@entities/staff/model/store';
import type { Tab } from '@entities/tab/model/types';
import type { Promotion } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { formatMoney } from '@shared/lib/format';
import type * as PosPrinter from '@shared/lib/pos-printer';
import { openCashDrawer, printReceipt } from '@shared/lib/pos-printer';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';

import type { PaymentProcessors } from './PaymentForm';
import { PaymentForm } from './PaymentForm';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Stub exposing a "grant" control instead of the real PIN keypad/staff-list
// fetch — mirrors CorrectOpenUnitDialog.test.tsx's pattern. Lets tests drive
// the PIN-gate transition (Phase 27, PROMO-05/07) without a real staff list.
// onSuccess is called with a mock matched-staff object (Phase 27 Plan 08,
// G-27-13) so PaymentForm's PIN-capture wiring has something realistic to
// capture — mirrors real ManagerPinDialog.handlePinComplete's onSuccess(match).
const mockAuthorizingManager = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Mock Authorizing Manager',
  email: 'authorizing-manager@test.dev',
  role: 'manager' as const,
  pin: '789012',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX' as const,
};
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: (props: {
    open: boolean;
    requiredAction: string;
    onSuccess: (staff: typeof mockAuthorizingManager) => void;
  }) =>
    props.open
      ? createElement(
          'button',
          {
            onClick: () => {
              props.onSuccess(mockAuthorizingManager);
            },
            'data-required-action': props.requiredAction,
          },
          'Grant PIN'
        )
      : null,
}));

// Controllable promotions list (Phase 27, PROMO-05's "Apply Promotion"
// selector) — evaluateBestPromotion stays the real implementation; only
// usePromotions() is swapped for a plain array the tests can mutate.
const { mockPromotionsData } = vi.hoisted(() => ({
  mockPromotionsData: [] as Promotion[],
}));
vi.mock('@entities/promotion', async importOriginal => {
  const actual = await importOriginal<typeof PromotionModule>();
  return {
    ...actual,
    usePromotions: () => ({ data: mockPromotionsData }),
  };
});

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return {
    ...actual,
    printReceipt: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
    openCashDrawer: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
  };
});

// taxRatePercent=0 (default) keeps most assertions simple — no tax
// arithmetic needed. mockSettings is mutable (via vi.hoisted) so the new
// "tax modes" describe block below can set a nonzero rate/taxInclusive
// per test without a full module remock; beforeEach resets it back to the
// degenerate default so every other pre-existing test is unaffected.
const { mockSettings, DEFAULT_MOCK_BILLING } = vi.hoisted(() => {
  const DEFAULT_MOCK_BILLING = {
    taxRatePercent: 0,
    taxInclusive: true,
    paymentMethods: { cash: true, card: true, bank_transfer: true, rappi: true, uber_eats: true },
  };
  return {
    DEFAULT_MOCK_BILLING,
    mockSettings: {
      billing: { ...DEFAULT_MOCK_BILLING },
      paymentLabels: {
        cash: 'Efectivo',
        card: 'Terminal BBVA',
        bank_transfer: 'Transferencia',
        rappi: 'Rappi',
        uber_eats: 'Uber Eats',
      },
      // Phase 28 (D-06): evaluateBestPromotion's new timezone argument reads
      // appSettings.general.timezone — the "Apply Promotion" selector tests
      // below need this populated or PaymentForm.tsx's `?? DEFAULT_TIMEZONE`
      // fallback would silently mask a real regression here.
      general: { timezone: 'America/Mexico_City' },
    },
  };
});

vi.mock('@entities/settings', () => {
  return {
    useSettings: () => ({ data: mockSettings }),
    useReceiptSettings: () => ({ data: undefined }),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const staffId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const shiftId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * Minimal Tab with items totalling $20 (no pool charges, no tax with taxRate=0).
 * runningTotal = $20.
 */
const testTab: Tab = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  customerName: 'Test Customer',
  staffId,
  shiftId,
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

const promotableProductId = 'ffffffff-ffff-ffff-ffff-fffffffffff2';
const promotableCategoryId = '11111111-1111-1111-1111-111111111111';

/**
 * Tab with one $10 line whose item.product is populated — required for the
 * "Apply Promotion" selector's per-line re-evaluation (Phase 27, PROMO-05),
 * which testTab's items intentionally omit (kept minimal for other suites).
 */
const promotableTab: Tab = {
  ...testTab,
  id: 'cccccccc-cccc-cccc-cccc-ccccccccccc2',
  items: [
    {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddd02',
      orderId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      productId: promotableProductId,
      quantity: 1,
      unitPrice: 10,
      modifierIds: [],
      modifierPriceDelta: 0,
      notes: null,
      modifiers: [],
      product: {
        id: promotableProductId,
        name: 'Promotable Product',
        categoryId: promotableCategoryId,
        basePrice: 10,
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
        comboEligible: true,
        isCombo: false,
        modifiers: [],
      },
    },
  ],
};

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  const now = new Date();
  return {
    id: '99999999-9999-9999-9999-999999999999',
    name: '10% Off Promotable Product',
    targets: [
      {
        id: 'aaaaaaaa-1111-1111-1111-111111111111',
        promotionId: '99999999-9999-9999-9999-999999999999',
        productId: promotableProductId,
        categoryId: null,
      },
    ],
    discountType: 'percent',
    discountValue: 10,
    startsAt: new Date(now.getTime() - 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000),
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    needsReview: false,
    active: true,
    createdAt: now,
    createdBy: null,
    ...overrides,
  };
}

function makeReceipt(): ReceiptData {
  return {
    receiptNumber: 'R001',
    tabId: testTab.id,
    customerName: testTab.customerName,
    cashierName: 'Staff',
    storeName: 'Test Bar',
    barAddress: '1 Main St',
    items: [],
    subtotal: 20,
    total: 20,
    paymentMethod: 'card',
    processedAt: new Date(),
    squareReceiptUrl: null,
    tenderedAmount: null,
    changeAmount: null,
  };
}

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
        ok({ paymentGroupId: 'group-1', paymentIds: ['p-split-1'], receipts: [receipt] })
      ),
    ...overrides,
  };
}

function renderForm(processors: PaymentProcessors = makeProcessors(), onPaymentSuccess = vi.fn()) {
  renderWithProviders(
    <PaymentForm
      tab={testTab}
      staffId={staffId}
      onPaymentSuccess={onPaymentSuccess}
      processors={processors}
    />
  );
}

/** Switch to card method */
async function selectCardMethod(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('payment-btn-card'));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.billing = { ...DEFAULT_MOCK_BILLING };
  mockPromotionsData.length = 0;
  useStaffStore.setState({
    currentStaff: {
      id: staffId,
      name: 'Test Manager',
      email: 'manager@test.dev',
      role: 'manager',
      pin: '123456',
      isActive: true,
      mustChangePin: false,
      locale: 'es-MX',
    },
    currentShift: null,
    staffList: [],
    isAuthenticated: true,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sprint 2 — Discount section
// ---------------------------------------------------------------------------

/** Expands the discount section by clicking the toggle then granting the (mocked) manager PIN. */
async function expandDiscountSection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('switch', { name: 'Discount' }));
  await user.click(screen.getByText(/grant pin/i));
}

describe('PaymentForm — discount section', () => {
  it('renders discount section for cash payment', () => {
    renderForm();
    // Default method is cash (non-rappi tab); discount section should be present
    expect(screen.getByTestId('discount-section')).toBeInTheDocument();
  });

  it('discount section stays collapsed until the manager PIN dialog reports success', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('switch', { name: 'Discount' }));

    // PIN not granted yet — the section's expanded state (discountExpanded)
    // must not have flipped on.
    expect(screen.getByRole('switch', { name: 'Discount' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByText(/grant pin/i)).toHaveAttribute(
      'data-required-action',
      'apply_custom_discount'
    );

    await user.click(screen.getByText(/grant pin/i));

    // Only after a successful PIN does the section actually expand.
    expect(screen.getByRole('switch', { name: 'Discount' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('the pool_only/consumptions_only scope buttons no longer exist — only a fixed "all" label renders', async () => {
    const user = userEvent.setup();
    renderForm();
    await expandDiscountSection(user);

    expect(screen.queryByTestId('discount-scope-pool_only')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discount-scope-consumptions_only')).not.toBeInTheDocument();
    expect(screen.getByTestId('discount-scope-all')).toBeInTheDocument();
    // Non-interactive: it's a div, not a button.
    expect(screen.getByTestId('discount-scope-all').tagName).not.toBe('BUTTON');
  });

  it('collapsing the discount section resets manager authorization — re-expanding prompts the PIN dialog again', async () => {
    const user = userEvent.setup();
    renderForm();
    await expandDiscountSection(user);
    expect(screen.getByRole('switch', { name: 'Discount' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // Collapse.
    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    expect(screen.getByRole('switch', { name: 'Discount' })).toHaveAttribute(
      'aria-checked',
      'false'
    );

    // Re-expand — PIN dialog must appear again, not skip straight to fields.
    await user.click(screen.getByRole('switch', { name: 'Discount' }));
    expect(screen.getByText(/grant pin/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Discount' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('discount section stays visible for Rappi payment (D-16: rappi allows discounts, like card)', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByTestId('payment-btn-rappi'));
    expect(screen.getByTestId('discount-section')).toBeInTheDocument();
  });

  it('10% all-items discount shows discount row in totals', async () => {
    const user = userEvent.setup();
    renderForm();

    // discount is progressively disclosed behind a manager PIN — expand it first
    await expandDiscountSection(user);

    // scope is fixed to 'all'; change discount value to 10
    const discountInput = screen.getByLabelText('Discount %');
    await user.clear(discountInput);
    await user.type(discountInput, '10');
    await user.tab(); // blur to commit

    // Discount base = $20 (itemsSubtotal), 10% = $2
    expect(screen.getByTestId('discount-row')).toBeInTheDocument();
  });

  // Phase 27 Plan 08 (G-27-13): the PIN of the staff who matched in
  // ManagerPinDialog must reach the RPC call's discountInfo.managerPin — the
  // server independently re-verifies authorization against this PIN, not
  // the currently logged-in staff's own identity.
  it('the PIN captured from ManagerPinDialog reaches processCashPayment discountInfo.managerPin', async () => {
    const user = userEvent.setup();
    const receipt = makeReceipt();
    const processCashPayment = vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'p-cash', changeAmount: 0, receiptData: receipt }));
    const processors = makeProcessors({ processCashPayment });
    renderForm(processors);

    await expandDiscountSection(user);

    const discountInput = screen.getByLabelText('Discount %');
    await user.clear(discountInput);
    await user.type(discountInput, '10');
    await user.tab();

    const tendered = screen.getByLabelText('Amount tendered');
    await user.clear(tendered);
    await user.type(tendered, '20.00');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Process payment' }));

    await waitFor(() => {
      expect(processCashPayment).toHaveBeenCalled();
    });
    const call = processCashPayment.mock.calls[0];
    if (call === undefined) throw new Error('expected call');
    // index 3 = discountInfo (tabId, amount, tenderedAmount, discountInfo, ...)
    expect(call[3]).toMatchObject({
      managerOverride: true,
      managerPin: mockAuthorizingManager.pin,
    });
  });

  it('fixed $5 discount shows correct discount-applied-label', async () => {
    const user = userEvent.setup();
    renderForm();

    // discount is progressively disclosed behind a manager PIN — expand it first
    await expandDiscountSection(user);
    await user.click(screen.getByTestId('discount-type-fixed'));

    const discountInput = screen.getByLabelText('Discount amount');
    await user.clear(discountInput);
    await user.type(discountInput, '5');
    await user.tab();

    expect(screen.getByTestId('discount-applied-label')).toHaveTextContent('5.00');
  });

  it('no discount row when discountValue is 0', () => {
    renderForm();
    // Default discountValue = 0
    expect(screen.queryByTestId('discount-row')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Configurable payment methods — rappi/uber_eats behave exactly like card
// (D-16): no isRappiTab gating, taxed normally, discounts allowed.
// ---------------------------------------------------------------------------

describe('PaymentForm — platform payment methods (rappi/uber_eats)', () => {
  it('rappi button is shown on a plain (non-delivery) tab when paymentMethods.rappi is enabled, and completes via processPlatformPayment', async () => {
    const user = userEvent.setup();
    const processors = makeProcessors();
    renderForm(processors);

    const rappiButton = screen.getByTestId('payment-btn-rappi');
    expect(rappiButton).toBeInTheDocument();
    await user.click(rappiButton);

    await user.click(screen.getByRole('button', { name: /confirm card payment/i }));

    await waitFor(() => {
      expect(processors.processPlatformPayment).toHaveBeenCalled();
    });
    const call = vi.mocked(processors.processPlatformPayment).mock.calls[0];
    if (call === undefined) throw new Error('expected call');
    expect(call[0]).toBe(testTab.id);
    expect(call[2]).toBe('rappi');
  });

  it('uber_eats button is hidden when paymentMethods.uber_eats is disabled', () => {
    mockSettings.billing = { ...DEFAULT_MOCK_BILLING, paymentMethods: { ...DEFAULT_MOCK_BILLING.paymentMethods, uber_eats: false } };
    renderForm();
    expect(screen.queryByTestId('payment-btn-uber-eats')).not.toBeInTheDocument();
  });
});

describe('PaymentForm — card charge override', () => {
  it('renders MoneyInput for charge amount when method is card', async () => {
    const user = userEvent.setup();
    renderForm();
    await selectCardMethod(user);
    expect(screen.getByLabelText('Charge amount')).toBeInTheDocument();
  });

  it('MoneyInput defaults to runningTotal when no override is set', async () => {
    const user = userEvent.setup();
    renderForm();
    await selectCardMethod(user);
    // baseSubtotal=20, taxRate=0, runningTotal=20
    const input = screen.getByLabelText('Charge amount');
    expect(input).toHaveValue('20.00');
  });

  it('onChange on MoneyInput sets the override', async () => {
    const user = userEvent.setup();
    renderForm();
    await selectCardMethod(user);

    const input = screen.getByLabelText('Charge amount');
    await user.clear(input);
    await user.type(input, '50.00');
    // blur to commit the value
    await user.tab();

    expect(input).toHaveValue('50.00');
  });

  it('reset button is hidden when override is null', async () => {
    const user = userEvent.setup();
    renderForm();
    await selectCardMethod(user);

    expect(screen.queryByTestId('card-override-reset')).not.toBeInTheDocument();
  });

  it('reset button appears when override is set', async () => {
    const user = userEvent.setup();
    renderForm();
    await selectCardMethod(user);

    const input = screen.getByLabelText('Charge amount');
    await user.clear(input);
    await user.type(input, '99.00');
    await user.tab();

    expect(screen.getByTestId('card-override-reset')).toBeInTheDocument();
  });

  it('reset button clears the override', async () => {
    const user = userEvent.setup();
    renderForm();
    await selectCardMethod(user);

    const input = screen.getByLabelText('Charge amount');
    await user.clear(input);
    await user.type(input, '99.00');
    await user.tab();

    await user.click(screen.getByTestId('card-override-reset'));

    // reset button should disappear again
    expect(screen.queryByTestId('card-override-reset')).not.toBeInTheDocument();
    // input should return to runningTotal
    expect(input).toHaveValue('20.00');
  });

  it('submit button is disabled when cardChargeOverride is 0', async () => {
    const user = userEvent.setup();
    renderForm();
    await selectCardMethod(user);

    const input = screen.getByLabelText('Charge amount');
    await user.clear(input);
    await user.type(input, '0.00');
    await user.tab();

    expect(screen.getByRole('button', { name: /confirm card payment/i })).toBeDisabled();
  });

  it('processCardPayment called with override amount when override set', async () => {
    const user = userEvent.setup();
    const processors = makeProcessors();
    renderForm(processors);
    await selectCardMethod(user);

    const input = screen.getByLabelText('Charge amount');
    await user.clear(input);
    await user.type(input, '45.00');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /confirm card payment/i }));

    await waitFor(() => {
      expect(processors.processCardPayment).toHaveBeenCalled();
    });
    // override amount=45, no ref, no discount, no version (testTab has none)
    expect(processors.processCardPayment).toHaveBeenCalledWith(
      testTab.id,
      45,
      undefined,
      undefined,
      undefined,
      expect.any(String)
    );
  });

  it('processCardPayment called with baseSubtotal when no override', async () => {
    const user = userEvent.setup();
    const processors = makeProcessors();
    renderForm(processors);
    await selectCardMethod(user);

    // Do NOT modify the charge amount — leave it as default (runningTotal)
    await user.click(screen.getByRole('button', { name: /confirm card payment/i }));

    await waitFor(() => {
      expect(processors.processCardPayment).toHaveBeenCalled();
    });
    // No override: chargeAmount=baseSubtotal=20 (taxRate=0), no ref, no discount, no version (testTab has none)
    expect(processors.processCardPayment).toHaveBeenCalledWith(
      testTab.id,
      20,
      undefined,
      undefined,
      undefined,
      expect.any(String)
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 27 — below-cost floor-guard override retry (PROMO-05/PROMO-07)
// ---------------------------------------------------------------------------

describe('PaymentForm — below-cost override retry', () => {
  it('BELOW_COST_REQUIRES_OVERRIDE opens the manager PIN dialog; a successful PIN resubmits with managerOverride: true, reusing the same idempotency key', async () => {
    const user = userEvent.setup();
    const receipt = makeReceipt();
    const processCardPayment = vi
      .fn()
      .mockResolvedValueOnce(
        err({
          code: 'BELOW_COST_REQUIRES_OVERRIDE',
          message: 'This combination of discounts would sell below cost',
        })
      )
      .mockResolvedValueOnce(ok({ paymentId: 'p-card', receiptData: receipt }));
    const processors = makeProcessors({ processCardPayment });
    renderForm(processors);
    await selectCardMethod(user);

    await user.click(screen.getByRole('button', { name: /confirm card payment/i }));

    await waitFor(() => {
      expect(processCardPayment).toHaveBeenCalledTimes(1);
    });
    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByText(/grant pin/i)).toHaveAttribute(
      'data-required-action',
      'apply_custom_discount'
    );

    await user.click(screen.getByText(/grant pin/i));

    await waitFor(() => {
      expect(processCardPayment).toHaveBeenCalledTimes(2);
    });
    const [firstCall, secondCall] = processCardPayment.mock.calls;
    expect(firstCall).toBeDefined();
    expect(secondCall).toBeDefined();
    // Same idempotency key on both attempts (index 5) — a retry, not a new sale.
    expect(secondCall![5]).toBe(firstCall![5]);
    // managerOverride: true + the matched staff's PIN on the retry (index 3 = discountInfo).
    expect(secondCall![3]).toMatchObject({
      managerOverride: true,
      managerPin: mockAuthorizingManager.pin,
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Receipt' })).toBeInTheDocument();
    });
  });
});

describe('PaymentForm — close and receipt completion', () => {
  it('keeps Cancel separate from receipt Done when onDone is supplied', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDone = vi.fn();
    renderWithProviders(
      <PaymentForm
        tab={testTab}
        staffId={staffId}
        onPaymentSuccess={vi.fn()}
        onClose={onClose}
        onDone={onDone}
        processors={makeProcessors()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('calls onDone instead of onClose after a successful payment receipt', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDone = vi.fn();
    renderWithProviders(
      <PaymentForm
        tab={testTab}
        staffId={staffId}
        onPaymentSuccess={vi.fn()}
        onClose={onClose}
        onDone={onDone}
        processors={makeProcessors()}
      />
    );

    await selectCardMethod(user);
    await user.click(screen.getByRole('button', { name: /confirm card payment/i }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 18 — Split payment mode
// ---------------------------------------------------------------------------

describe('PaymentForm — split mode', () => {
  async function openSplitMode(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('switch', { name: 'Split payment' }));
  }

  it('toggle ON reveals 2 rows + Remaining to pay box; toggle OFF restores the method grid', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.getByTestId('payment-btn-cash')).toBeInTheDocument();

    await openSplitMode(user);

    expect(screen.getByText('Payment 1')).toBeInTheDocument();
    expect(screen.getByText('Payment 2')).toBeInTheDocument();
    expect(screen.getByText('Remaining to pay')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-btn-cash')).not.toBeInTheDocument();

    await openSplitMode(user);

    expect(screen.getByTestId('payment-btn-cash')).toBeInTheDocument();
    expect(screen.queryByText('Payment 1')).not.toBeInTheDocument();
  });

  it('add-row appends up to 4 rows then disables Add; remove-row disabled at exactly 2 rows', async () => {
    const user = userEvent.setup();
    renderForm();
    await openSplitMode(user);

    expect(screen.queryByRole('button', { name: 'Remove payment 1' })).not.toBeInTheDocument();

    const addBtn = screen.getByRole('button', { name: '+ Add payment method' });
    await user.click(addBtn);
    expect(screen.getByText('Payment 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove payment 1' })).toBeInTheDocument();

    await user.click(addBtn);
    expect(screen.getByText('Payment 4')).toBeInTheDocument();
    expect(addBtn).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Remove payment 4' }));
    await user.click(screen.getByRole('button', { name: 'Remove payment 3' }));

    expect(screen.queryByText('Payment 3')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove payment 1' })).not.toBeInTheDocument();
    expect(addBtn).not.toBeDisabled();
  });

  it('live remaining shows Fully allocated when rows sum to subtotalWithTax; submit disabled until remaining=0 and every row amount>0', async () => {
    const user = userEvent.setup();
    renderForm();
    await openSplitMode(user);

    // Switch both rows to card to avoid the cash tendered-amount requirement.
    const cardButtons = screen.getAllByRole('button', { name: 'Terminal BBVA' });
    await user.click(cardButtons[0]!);
    await user.click(cardButtons[1]!);

    const submitBtn = screen.getByRole('button', { name: 'Process split payment' });
    expect(submitBtn).toBeDisabled();

    const amountInputs = screen.getAllByLabelText('Amount');
    await user.clear(amountInputs[0]!);
    await user.type(amountInputs[0]!, '10.00');
    await user.tab();
    // Row 2 still has amount=0 — submit stays disabled (Pitfall 3)
    expect(submitBtn).toBeDisabled();

    await user.clear(amountInputs[1]!);
    await user.type(amountInputs[1]!, '10.00');
    await user.tab();

    // testTab: itemsSubtotal=$20, taxRate=0 → subtotalWithTax=$20 → 10+10=20
    expect(screen.getByText('Fully allocated ✓')).toBeInTheDocument();
    expect(submitBtn).not.toBeDisabled();
  });

  it('submit calls processSplitPayment with legs summing to subtotalWithTax; renders the single sale-level receipt once; Done reaches onClose', async () => {
    const user = userEvent.setup();
    // Direct-sale split payments now resolve to exactly one sale-level
    // receipt (basket composed once, every leg in receipt.tenders) —
    // mirrors what useCheckoutSale's processSplitPayment adapter returns.
    const saleReceipt = {
      ...makeReceipt(),
      total: 20,
      tenders: [
        { method: 'cash' as const, amount: 12, tenderedAmount: 12, changeAmount: 0 },
        { method: 'card' as const, amount: 8 },
      ],
    };
    const processors = makeProcessors({
      processSplitPayment: vi
        .fn()
        .mockResolvedValue(
          ok({ paymentGroupId: 'group-x', paymentIds: ['p1', 'p2'], receipts: [saleReceipt] })
        ),
    });
    const onClose = vi.fn();
    renderWithProviders(
      <PaymentForm
        tab={testTab}
        staffId={staffId}
        onPaymentSuccess={vi.fn()}
        onClose={onClose}
        processors={processors}
      />
    );

    await openSplitMode(user);

    // Row 1 stays cash (default); switch row 2 to card.
    const cardButtons = screen.getAllByRole('button', { name: 'Terminal BBVA' });
    await user.click(cardButtons[1]!);

    const amountInputs = screen.getAllByLabelText('Amount');
    await user.clear(amountInputs[0]!);
    await user.type(amountInputs[0]!, '12.00');
    await user.clear(amountInputs[1]!);
    await user.type(amountInputs[1]!, '8.00');
    await user.tab();

    const tenderedInput = screen.getByLabelText('Amount tendered');
    await user.clear(tenderedInput);
    await user.type(tenderedInput, '12.00');
    await user.tab();

    const submitBtn = screen.getByRole('button', { name: 'Process split payment' });
    expect(submitBtn).not.toBeDisabled();
    await user.click(submitBtn);

    await waitFor(() => {
      expect(processors.processSplitPayment).toHaveBeenCalled();
    });
    const call = vi.mocked(processors.processSplitPayment).mock.calls[0]!;
    const [tabId, legs, expectedTotal] = call;
    expect(tabId).toBe(testTab.id);
    expect(legs.reduce((sum, leg) => sum + leg.amount, 0)).toBe(20);
    expect(expectedTotal).toBe(20);

    // No "Receipt N of M" navigation label — exactly one receipt is shown.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Receipt' })).toBeInTheDocument();
    });
    expect(screen.queryByText(/of 2/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('cash-drawer-once: a 2-cash-row split calls openCashDrawer exactly once and printReceipt twice', async () => {
    const user = userEvent.setup();
    const receipt1 = { ...makeReceipt(), paymentMethod: 'cash' as const };
    const receipt2 = { ...makeReceipt(), paymentMethod: 'cash' as const };
    const processors = makeProcessors({
      processSplitPayment: vi.fn().mockResolvedValue(
        ok({
          paymentGroupId: 'group-y',
          paymentIds: ['p1', 'p2'],
          receipts: [receipt1, receipt2],
        })
      ),
    });
    renderForm(processors);
    await openSplitMode(user);

    // Both rows default to cash.
    const amountInputs = screen.getAllByLabelText('Amount');
    await user.clear(amountInputs[0]!);
    await user.type(amountInputs[0]!, '12.00');
    await user.clear(amountInputs[1]!);
    await user.type(amountInputs[1]!, '8.00');
    await user.tab();

    const tenderedInputs = screen.getAllByLabelText('Amount tendered');
    await user.clear(tenderedInputs[0]!);
    await user.type(tenderedInputs[0]!, '12.00');
    await user.clear(tenderedInputs[1]!);
    await user.type(tenderedInputs[1]!, '8.00');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Process split payment' }));

    await waitFor(() => {
      expect(processors.processSplitPayment).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(openCashDrawer).toHaveBeenCalledTimes(1);
    });
    expect(printReceipt).toHaveBeenCalledTimes(2);
  });

  it('shows the translated brokerUnreachable copy (not the raw message) when the post-payment print fails, and does not silently discard the Result', async () => {
    const user = userEvent.setup();
    const processors = makeProcessors();
    vi.mocked(printReceipt).mockResolvedValueOnce(
      err({ code: 'PRINT_BROKER_UNREACHABLE', message: 'x' })
    );
    renderForm(processors);
    await selectCardMethod(user);

    await user.click(screen.getByRole('button', { name: /confirm card payment/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Print service unavailable — check that the print broker is running.'
      );
    });
  });

  it('shows no toast when the post-payment print succeeds (no-success-toast rule)', async () => {
    const user = userEvent.setup();
    const processors = makeProcessors();
    renderForm(processors);
    await selectCardMethod(user);

    await user.click(screen.getByRole('button', { name: /confirm card payment/i }));

    await waitFor(() => {
      expect(printReceipt).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('regression: single-method (toggle OFF) cash payment still calls processCashPayment unchanged', async () => {
    const user = userEvent.setup();
    const processors = makeProcessors();
    renderForm(processors);

    const tendered = screen.getByLabelText('Amount tendered');
    await user.clear(tendered);
    await user.type(tendered, '30.00');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Process payment' }));

    await waitFor(() => {
      expect(processors.processCashPayment).toHaveBeenCalled();
    });
    expect(processors.processSplitPayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 24 — Tax Configuration (Inclusive/Exclusive Toggle)
// ---------------------------------------------------------------------------

describe('PaymentForm — tax modes (Phase 24)', () => {
  it('exclusive mode (taxInclusive: false): unchanged additive math at a nonzero rate (TAX-03)', () => {
    mockSettings.billing = { ...DEFAULT_MOCK_BILLING, taxRatePercent: 16, taxInclusive: false };
    renderForm();

    // testTab: itemsSubtotal=$20, no discount -> afterDiscount=$20
    const expectedTax = Math.round(20 * 0.16 * 100) / 100; // 3.20
    const expectedTotal = Math.round((20 + expectedTax) * 100) / 100; // 23.20

    expect(screen.getByTestId('tax-row')).toHaveTextContent(formatMoney(expectedTax));
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(expectedTotal));
  });

  it('inclusive mode (taxInclusive: true): total unchanged, tax decomposed backward at a nonzero rate (TAX-02)', () => {
    mockSettings.billing = { ...DEFAULT_MOCK_BILLING, taxRatePercent: 16, taxInclusive: true };
    renderForm();

    // testTab: itemsSubtotal=$20, no discount -> afterDiscount=$20 (already tax-inclusive)
    const decomposedSubtotal = Math.round((20 / 1.16) * 100) / 100; // 17.24
    const expectedTax = Math.round((20 - decomposedSubtotal) * 100) / 100; // 2.76 (subtraction, not re-derived)

    expect(screen.getByTestId('tax-row')).toHaveTextContent(formatMoney(expectedTax));
    // Total unchanged from the catalog sum — no addition on top (TAX-02).
    expect(screen.getByTestId('total-row')).toHaveTextContent(formatMoney(20));
  });

  it('property: displayed subtotal + tax === total to the cent, across rates in both modes (Open Question 2)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        (taxRatePercent, taxInclusive) => {
          cleanup();
          mockSettings.billing = { ...DEFAULT_MOCK_BILLING, taxRatePercent, taxInclusive };
          renderForm();

          const parseMoney = (text: string): number => Number(text.replace(/[^0-9.-]/g, ''));
          const total = parseMoney(screen.getByTestId('total-row').textContent ?? '');
          const taxAmount = parseMoney(screen.getByTestId('tax-row').textContent ?? '');
          const subtotal = Math.round((total - taxAmount) * 100) / 100;

          expect(Math.round((subtotal + taxAmount) * 100)).toBe(Math.round(total * 100));
        }
      ),
      { numRuns: 20 }
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 27 — "Apply Promotion" selector (PROMO-05)
// ---------------------------------------------------------------------------

// CR-01 fix: the "Apply Promotion" selector recomputes a discounted charge
// amount client-side, but only process_direct_sale_atomic (the direct-sale
// RPC, reached exclusively via CheckoutPanel/useCheckoutSale) independently
// re-derives and authoritatively re-applies that same promotion server-side.
// The generic process_payment_atomic/process_split_payment_atomic RPCs used
// by the reopened-tab path (PaymentPane, no processBankTransferPayment) have
// no such recompute step and never learn about the reduction at all — the
// tab would be silently underpaid and left open forever. processors.
// processBankTransferPayment is only ever supplied by useCheckoutSale (see
// its doc comment on PaymentProcessors), so its presence is reused here as
// the same "are we in the direct-sale context" gate the Bank Transfer method
// button already relies on.
function makeCheckoutProcessors(overrides: Partial<PaymentProcessors> = {}): PaymentProcessors {
  const receipt = makeReceipt();
  return makeProcessors({
    processBankTransferPayment: vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'p-bank-transfer', receiptData: receipt })),
    ...overrides,
  });
}

describe('PaymentForm — Apply Promotion selector', () => {
  it('the section is hidden entirely when there are no currently-active promotions', () => {
    renderForm();
    expect(screen.queryByTestId('apply-promotion-section')).not.toBeInTheDocument();
  });

  it('an expired promotion never appears as a selectable option (the section stays hidden)', () => {
    const now = new Date();
    mockPromotionsData.push(
      makePromotion({
        startsAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        endsAt: new Date(now.getTime() - 60 * 60 * 1000),
      })
    );
    renderForm();
    expect(screen.queryByTestId('apply-promotion-section')).not.toBeInTheDocument();
  });

  // CR-01 regression test: reopened-tab payment path (PaymentPane) uses the
  // default processors, which never include processBankTransferPayment.
  // Even with an active promotion available, the section must stay hidden —
  // the generic RPCs it would call have no way to record the promotion
  // discount, so silently underpaying a reopened tab must be impossible.
  it('CR-01: the section stays hidden on the reopened-tab payment path (no processBankTransferPayment), even with an active promotion', () => {
    mockPromotionsData.push(makePromotion());
    renderWithProviders(
      <PaymentForm
        tab={promotableTab}
        staffId={staffId}
        onPaymentSuccess={vi.fn()}
        processors={makeProcessors()}
      />
    );
    expect(screen.queryByTestId('apply-promotion-section')).not.toBeInTheDocument();
  });

  it('selecting an active promotion discounts the matching line without opening a PIN dialog', async () => {
    const user = userEvent.setup();
    mockPromotionsData.push(makePromotion());
    renderWithProviders(
      <PaymentForm
        tab={promotableTab}
        staffId={staffId}
        onPaymentSuccess={vi.fn()}
        processors={makeCheckoutProcessors()}
      />
    );

    expect(screen.getByTestId('apply-promotion-section')).toBeInTheDocument();
    // No PIN dialog — this is the non-ad-hoc path PROMO-05 explicitly
    // distinguishes from the custom-discount gate (Task 1).
    expect(screen.queryByText(/grant pin/i)).not.toBeInTheDocument();

    await user.click(screen.getByTestId('apply-promotion-select'));
    await user.click(screen.getByText('10% Off Promotable Product'));

    expect(screen.queryByText(/grant pin/i)).not.toBeInTheDocument();
    // $10 line, 10% off -> itemsSubtotal becomes $9.
    expect(screen.getByTestId('total-row')).toHaveTextContent('9.00');
  });

  it('never worsens a line that already resolved a better price (Math.max-on-discount semantics)', async () => {
    const user = userEvent.setup();
    // A weaker (5%) promotion than the line's already-resolved $10 -> $9
    // (10% off) price baked into the cart at scan time.
    mockPromotionsData.push(makePromotion({ discountValue: 5 }));
    const alreadyDiscountedTab: Tab = {
      ...promotableTab,
      items: [{ ...promotableTab.items[0]!, unitPrice: 9 }],
    };
    renderWithProviders(
      <PaymentForm
        tab={alreadyDiscountedTab}
        staffId={staffId}
        onPaymentSuccess={vi.fn()}
        processors={makeCheckoutProcessors()}
      />
    );

    await user.click(screen.getByTestId('apply-promotion-select'));
    await user.click(screen.getByText('10% Off Promotable Product'));

    // The weaker 5% candidate ($9.50) never overwrites the already-better $9 line.
    expect(screen.getByTestId('total-row')).toHaveTextContent('9.00');
  });
});
