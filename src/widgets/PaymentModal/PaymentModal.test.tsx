import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import type { Tab } from '@entities/tab/model/types';
import type { OrderItem, Product } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import type * as PosPrinter from '@shared/lib/pos-printer';
import { printReceipt, openCashDrawer } from '@shared/lib/pos-printer';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';
import { PaymentModal, type PaymentProcessors } from './index';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Stub exposing a "grant" control instead of the real PIN keypad/staff-list
// fetch (Phase 27, PROMO-05/07's discount-section PIN gate) — same pattern
// as PaymentForm.test.tsx and CorrectOpenUnitDialog.test.tsx.
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: (props: { open: boolean; requiredAction: string; onSuccess: () => void }) =>
    props.open
      ? createElement(
          'button',
          { onClick: props.onSuccess, 'data-required-action': props.requiredAction },
          'Grant PIN'
        )
      : null,
}));

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return {
    ...actual,
    printReceipt: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
    openCashDrawer: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
    testPrint: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
  };
});

// Stable settings object — same reference every render so it doesn't trigger
// spurious resets of tenderedAmount. taxRatePercent=0 keeps test money
// amounts simple (no tax arithmetic in assertions).
vi.mock('@entities/settings', () => {
  const stableSettings = {
    billing: {
      taxRatePercent: 0,
      taxInclusive: true,
      paymentMethods: { cash: true, card: true, bank_transfer: true, rappi: true, uber_eats: true },
    },
    general: { timezone: 'America/Mexico_City' },
  };
  return {
    useSettings: () => ({ data: stableSettings }),
    useReceiptSettings: () => ({ data: undefined }),
  };
});

const categoryId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function miniProduct(partial: { id: string; name: string; basePrice: number }): Product {
  return {
    id: partial.id,
    name: partial.name,
    categoryId,
    basePrice: partial.basePrice,
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
  };
}

function orderItem(partial: {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  modifierPriceDelta?: number;
  product: Product;
}): OrderItem {
  return {
    id: partial.id,
    orderId: partial.orderId,
    productId: partial.productId,
    quantity: partial.quantity,
    unitPrice: partial.unitPrice,
    modifierIds: [],
    modifierPriceDelta: partial.modifierPriceDelta ?? 0,
    notes: null,
    modifiers: [],
    product: partial.product,
  };
}

const staffId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const shiftId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
const openedAt = new Date('2026-04-17T10:00:00.000Z');

const tabNoPool: Tab = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01',
  customerName: 'Sarah J.',
  staffId,
  shiftId,
  openedAt,
  closedAt: null,
  status: 'open',
  notes: null,
  orders: [],
  items: [
    orderItem({
      id: 'dddddddd-dddd-dddd-dddd-dddddddddd01',
      orderId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      productId: 'ffffffff-ffff-ffff-ffff-fffffffffff1',
      quantity: 2,
      unitPrice: 6.5,
      product: miniProduct({
        id: 'ffffffff-ffff-ffff-ffff-fffffffffff1',
        name: 'Beer',
        basePrice: 6.5,
      }),
    }),
    orderItem({
      id: 'dddddddd-dddd-dddd-dddd-dddddddddd02',
      orderId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      productId: 'ffffffff-ffff-ffff-ffff-fffffffffff2',
      quantity: 1,
      unitPrice: 9,
      product: miniProduct({
        id: 'ffffffff-ffff-ffff-ffff-fffffffffff2',
        name: 'Whiskey',
        basePrice: 9,
      }),
    }),
  ],
};

const tabRappi: Tab = {
  ...tabNoPool,
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa03',
  rappiOrderId: 'RAPPI-999',
};

function makeReceipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  const base: ReceiptData = {
    receiptNumber: 'RECEIPT1',
    tabId: tabNoPool.id,
    customerName: 'Sarah J.',
    cashierName: 'Staff',
    storeName: 'Test Bar',
    barAddress: '1 Main St',
    items: [
      { name: 'Beer', quantity: 2, unitPrice: 6.5, lineTotal: 13 },
      { name: 'Whiskey', quantity: 1, unitPrice: 9, lineTotal: 9 },
    ],
    subtotal: 22,
    total: 22,
    paymentMethod: 'cash',
    processedAt: new Date('2026-04-17T12:00:00.000Z'),
    squareReceiptUrl: null,
    tenderedAmount: 40,
    changeAmount: 18,
  };
  return { ...base, ...overrides };
}

function defaultProcessorMocks(receipt: ReceiptData): PaymentProcessors {
  return {
    processCashPayment: vi
      .fn()
      .mockResolvedValue(
        ok({ paymentId: 'pay-1', changeAmount: receipt.changeAmount ?? 0, receiptData: receipt })
      ),
    processCardPayment: vi.fn().mockResolvedValue(ok({ paymentId: 'pay-2', receiptData: receipt })),
    processPlatformPayment: vi
      .fn()
      .mockResolvedValue(ok({ paymentId: 'pay-3', receiptData: receipt })),
    processSplitPayment: vi
      .fn()
      .mockResolvedValue(
        ok({ paymentGroupId: 'group-1', paymentIds: ['pay-1'], receipts: [receipt] })
      ),
  };
}

function renderModal(
  tab: Tab,
  overrides: Partial<{
    open: boolean;
    processors: PaymentProcessors;
    onClose: () => void;
    onPaymentSuccess: () => void;
    staffId: string;
  }> = {}
) {
  const onClose = overrides.onClose ?? vi.fn();
  const receipt = makeReceipt({ tabId: tab.id, customerName: tab.customerName });
  const processors = overrides.processors ?? defaultProcessorMocks(receipt);
  const sid = overrides.staffId ?? staffId;
  renderWithProviders(
    <PaymentModal
      open={overrides.open ?? true}
      tab={tab}
      staffId={sid}
      onClose={onClose}
      {...(overrides.onPaymentSuccess != null
        ? { onPaymentSuccess: overrides.onPaymentSuccess }
        : {})}
      processors={processors}
    />
  );
  return { onClose, processors };
}

describe('PaymentModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStaffStore.setState({
      currentStaff: {
        id: staffId,
        name: 'Cashier',
        email: 'cashier@test.dev',
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

  afterEach(() => {
    useStaffStore.getState().logout();
  });

  it('shows customer, item lines, subtotals, and total without pool section', () => {
    renderModal(tabNoPool);
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByRole('heading', { name: 'Sarah J.' })).toBeInTheDocument();
    expect(within(dialog).getByText(/item type/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Beer/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Whiskey/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('$13.00 dollars')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('$9.00 dollars')).toBeInTheDocument();
    expect(within(dialog).getByText('Items subtotal')).toBeInTheDocument();
    const itemsSubtotalRow = within(dialog)
      .getByText('Items subtotal')
      .closest('div') as HTMLElement;
    expect(within(itemsSubtotalRow).getByLabelText('$22.00 dollars')).toBeInTheDocument();
    expect(within(dialog).getByText('Total')).toBeInTheDocument();
    const totalRow = within(dialog).getByText('Total').closest('div') as HTMLElement;
    expect(within(totalRow).getByLabelText('$22.00 dollars')).toBeInTheDocument();
    expect(within(dialog).queryByText('Pool charges')).not.toBeInTheDocument();
  });

  it('toggles payment method between cash and card', async () => {
    const user = userEvent.setup();
    renderModal(tabNoPool);
    const dialog = screen.getByRole('dialog');

    const cash = within(dialog).getByTestId('payment-btn-cash');
    const card = within(dialog).getByTestId('payment-btn-card');
    expect(cash.className).toContain('bg-primary');
    expect(card.className).toContain('border-border');

    await user.click(card);
    expect(card.className).toContain('bg-primary');
    expect(cash.className).toContain('border-border');

    await user.click(cash);
    expect(cash.className).toContain('bg-primary');
    expect(card.className).toContain('border-border');
  });

  it('shows Rappi method on a plain tab when paymentMethods.rappi is enabled', () => {
    renderModal(tabNoPool);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Rappi' })).toBeInTheDocument();
  });

  it('disables process payment until tendered covers total, then shows receipt', async () => {
    const user = userEvent.setup();
    const onPaymentSuccess = vi.fn();
    const receipt = makeReceipt();
    const processors: PaymentProcessors = {
      processCashPayment: vi
        .fn()
        .mockResolvedValue(ok({ paymentId: 'p1', changeAmount: 4.7, receiptData: receipt })),
      processCardPayment: vi.fn(),
      processPlatformPayment: vi.fn(),
      processSplitPayment: vi.fn(),
    };
    renderModal(tabNoPool, { processors, onPaymentSuccess });

    const payBtn = screen.getByRole('button', { name: 'Process payment' });
    expect(payBtn).toBeDisabled();

    const tendered = screen.getByLabelText('Amount tendered');
    await user.clear(tendered);
    await user.type(tendered, '30.00');

    expect(payBtn).not.toBeDisabled();
    await user.click(payBtn);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Receipt' })).toBeInTheDocument();
    });
    expect(onPaymentSuccess).toHaveBeenCalled();
    expect(processors.processCashPayment).toHaveBeenCalledWith(
      tabNoPool.id,
      22,
      30,
      undefined,
      undefined,
      expect.stringMatching(/^payment_cash_/)
    );
    expect(openCashDrawer).toHaveBeenCalled();
    expect(printReceipt).toHaveBeenCalledWith(receipt, expect.objectContaining({ paperWidthChars: 32 }));
    expect(vi.mocked(openCashDrawer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(printReceipt).mock.invocationCallOrder[0]!
    );

    await user.click(screen.getByRole('button', { name: 'Done' }));
  });

  it('prints without opening drawer after card payment', async () => {
    const user = userEvent.setup();
    const receipt = makeReceipt();
    const processors: PaymentProcessors = {
      processCashPayment: vi.fn(),
      processCardPayment: vi.fn().mockResolvedValue(ok({ paymentId: 'p2', receiptData: receipt })),
      processPlatformPayment: vi.fn(),
      processSplitPayment: vi.fn(),
    };
    renderModal(tabNoPool, { processors });

    await user.click(screen.getByTestId('payment-btn-card'));
    await user.click(screen.getByRole('button', { name: 'Confirm card payment' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Receipt' })).toBeInTheDocument();
    });
    expect(printReceipt).toHaveBeenCalledWith(receipt, expect.objectContaining({ paperWidthChars: 32 }));
    expect(openCashDrawer).not.toHaveBeenCalled();
  });

  it('shows payment error alert and stays open on failure', async () => {
    const user = userEvent.setup();
    const processors: PaymentProcessors = {
      processCashPayment: vi
        .fn()
        .mockResolvedValue(err({ code: 'VALIDATION_ERROR', message: 'Insufficient tender' })),
      processCardPayment: vi.fn(),
      processPlatformPayment: vi.fn(),
      processSplitPayment: vi.fn(),
    };
    const onClose = vi.fn();
    renderModal(tabNoPool, { processors, onClose });

    const tendered = screen.getByLabelText('Amount tendered');
    await user.clear(tendered);
    await user.type(tendered, '50.00');

    await user.click(screen.getByRole('button', { name: 'Process payment' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Insufficient tender');
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(tabNoPool, { onClose });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('allows bartender to process payment (close_tab is in bartender permissions)', async () => {
    const user = userEvent.setup();
    useStaffStore.setState({
      currentStaff: {
        id: staffId,
        name: 'B',
        email: 'b@b.dev',
        role: 'cashier',
        pin: '123456',
        isActive: true,
        mustChangePin: false,
        locale: 'es-MX',
      },
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });
    renderModal(tabNoPool);

    // Button is initially disabled because tendered amount is zero, not due to RBAC
    const payBtn = screen.getByRole('button', { name: 'Process payment' });
    expect(payBtn).toBeDisabled();

    // Once sufficient tender is entered, bartender can submit
    const tendered = screen.getByLabelText('Amount tendered');
    await user.clear(tendered);
    await user.type(tendered, '30.00');
    expect(payBtn).not.toBeDisabled();
  });

  it('shows change due for cash tendered above total', async () => {
    const user = userEvent.setup();
    renderModal(tabNoPool);
    const dialog = screen.getByRole('dialog');

    const tendered = within(dialog).getByLabelText('Amount tendered');
    await user.clear(tendered);
    await user.type(tendered, '40.00');

    expect(within(dialog).getByText('Change due')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('$18.00 dollars')).toBeInTheDocument();
  });

  it('completes Rappi payment without cash drawer', async () => {
    const user = userEvent.setup();
    const receipt = makeReceipt({
      tabId: tabRappi.id,
      paymentMethod: 'rappi',
      total: 22,
    });
    const processors: PaymentProcessors = {
      processCashPayment: vi.fn(),
      processCardPayment: vi.fn(),
      processPlatformPayment: vi
        .fn()
        .mockResolvedValue(ok({ paymentId: 'pay-r', receiptData: receipt })),
      processSplitPayment: vi.fn(),
    };
    renderModal(tabRappi, { processors });

    const dialog = screen.getByRole('dialog');
    // Rappi is no longer auto-selected from tab.rappiOrderId (D-16: platform
    // tenders are selectable on any tab, not gated by delivery origin).
    await user.click(within(dialog).getByRole('button', { name: 'Rappi' }));
    expect(within(dialog).getByRole('button', { name: 'Rappi' })).toHaveClass(/bg-primary/);

    await user.click(screen.getByRole('button', { name: 'Confirm card payment' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Receipt' })).toBeInTheDocument();
    });
    expect(processors.processPlatformPayment).toHaveBeenCalledWith(
      tabRappi.id,
      22,
      'rappi',
      undefined,
      undefined,
      undefined,
      expect.stringMatching(/^payment_rappi_/)
    );
    expect(openCashDrawer).not.toHaveBeenCalled();
    expect(printReceipt).toHaveBeenCalled();
  });

  it('passes BBVA terminal reference to card processor', async () => {
    const user = userEvent.setup();
    const receipt = makeReceipt({ paymentMethod: 'card' });
    const processors: PaymentProcessors = {
      processCashPayment: vi.fn(),
      processCardPayment: vi.fn().mockResolvedValue(ok({ paymentId: 'p2', receiptData: receipt })),
      processPlatformPayment: vi.fn(),
      processSplitPayment: vi.fn(),
    };
    renderModal(tabNoPool, { processors });

    await user.click(screen.getByTestId('payment-btn-card'));
    await user.type(screen.getByLabelText(/Reference/i), 'AUTH-777');
    await user.click(screen.getByRole('button', { name: 'Confirm card payment' }));

    await waitFor(() => {
      expect(processors.processCardPayment).toHaveBeenCalled();
    });
    expect(processors.processCardPayment).toHaveBeenCalledWith(
      tabNoPool.id,
      22,
      'AUTH-777',
      undefined,
      undefined,
      expect.stringMatching(/^payment_card_/)
    );
  });

  it('keeps primary disabled when staffId empty', () => {
    renderModal(tabNoPool, { staffId: '' });
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeDisabled();
  });

  it('toasts translated hardware-error copy (not the raw message) when cash drawer fails after cash payment', async () => {
    const user = userEvent.setup();
    const receipt = makeReceipt();
    const processors: PaymentProcessors = {
      processCashPayment: vi
        .fn()
        .mockResolvedValue(ok({ paymentId: 'p1', changeAmount: 4.7, receiptData: receipt })),
      processCardPayment: vi.fn(),
      processPlatformPayment: vi.fn(),
      processSplitPayment: vi.fn(),
    };
    vi.mocked(openCashDrawer).mockResolvedValue(
      err({ code: 'TAURI_ERROR', message: 'Drawer failed' })
    );

    renderModal(tabNoPool, { processors });

    const tendered = screen.getByLabelText('Amount tendered');
    await user.clear(tendered);
    await user.type(tendered, '30.00');
    await user.click(screen.getByRole('button', { name: 'Process payment' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't print after several attempts. Try again or check the printer."
      );
    });
  });

  // ── Discount section (Sprint 2) ────────────────────────────────────────────

  describe('discount section', () => {
    it('discount section is visible when method is cash', () => {
      renderModal(tabNoPool);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByTestId('discount-section')).toBeInTheDocument();
    });

    it('discount section stays visible when method is rappi (D-16: rappi allows discounts, like card)', async () => {
      const user = userEvent.setup();
      renderModal(tabRappi);
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Rappi' }));
      expect(within(dialog).getByTestId('discount-section')).toBeInTheDocument();
    });

    it('discount-scope-all button is the only scope option (Phase 27, PROMO-05 retirement)', async () => {
      const user = userEvent.setup();
      renderModal(tabNoPool);
      const dialog = screen.getByRole('dialog');
      // discount is progressively disclosed — expand it first
      await user.click(within(dialog).getByRole('switch', { name: 'Discount' }));
      const allBtn = within(dialog).getByTestId('discount-scope-all');
      expect(allBtn).toBeInTheDocument();
      expect(within(dialog).queryByTestId('discount-scope-pool_only')).not.toBeInTheDocument();
      expect(within(dialog).queryByTestId('discount-scope-consumptions_only')).not.toBeInTheDocument();
    });

    it('selecting Fixed type button changes the discount label to "Discount amount"', async () => {
      const user = userEvent.setup();
      renderModal(tabNoPool);
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('switch', { name: 'Discount' }));
      await user.click(within(dialog).getByText(/grant pin/i));
      await user.click(within(dialog).getByTestId('discount-type-fixed'));
      expect(within(dialog).getByLabelText('Discount amount')).toBeInTheDocument();
    });

    it('10% discount on $22 tab shows discount-applied-label with correct amount', async () => {
      const user = userEvent.setup();
      renderModal(tabNoPool);
      const dialog = screen.getByRole('dialog');

      // discount is progressively disclosed behind a manager PIN — expand it first
      await user.click(within(dialog).getByRole('switch', { name: 'Discount' }));
      await user.click(within(dialog).getByText(/grant pin/i));

      // Default is percent type — label is "Discount %"
      const discountInput = within(dialog).getByLabelText('Discount %');
      await user.clear(discountInput);
      await user.type(discountInput, '10');

      // tabNoPool itemsSubtotal = $22, 10% of $22 = $2.20
      await waitFor(() => {
        expect(within(dialog).getByTestId('discount-applied-label')).toBeInTheDocument();
      });
      expect(within(dialog).getByTestId('discount-applied-label')).toHaveTextContent('2.20');
    });

    it('fixed $5 discount on $22 tab shows discount-applied-label and discount-row', async () => {
      const user = userEvent.setup();
      renderModal(tabNoPool);
      const dialog = screen.getByRole('dialog');

      // discount is progressively disclosed behind a manager PIN — expand it first
      await user.click(within(dialog).getByRole('switch', { name: 'Discount' }));
      await user.click(within(dialog).getByText(/grant pin/i));
      await user.click(within(dialog).getByTestId('discount-type-fixed'));
      const discountInput = within(dialog).getByLabelText('Discount amount');
      await user.clear(discountInput);
      await user.type(discountInput, '5');

      await waitFor(() => {
        expect(within(dialog).getByTestId('discount-applied-label')).toBeInTheDocument();
      });
      expect(within(dialog).getByTestId('discount-applied-label')).toHaveTextContent('5.00');
      expect(within(dialog).getByTestId('discount-row')).toBeInTheDocument();
    });

    it('discount-row appears in totals section when discount is active', async () => {
      const user = userEvent.setup();
      renderModal(tabNoPool);
      const dialog = screen.getByRole('dialog');

      // discount is progressively disclosed behind a manager PIN — expand it first
      await user.click(within(dialog).getByRole('switch', { name: 'Discount' }));
      await user.click(within(dialog).getByText(/grant pin/i));
      const discountInput = within(dialog).getByLabelText('Discount %');
      await user.clear(discountInput);
      await user.type(discountInput, '10');

      await waitFor(() => {
        expect(within(dialog).getByTestId('discount-row')).toBeInTheDocument();
      });
    });
  });

  describe('historical line-item discount badge (Phase 27, PROMO-06)', () => {
    it('renders a discount indicator for a reopened line carrying a stored promotion snapshot', () => {
      const tabWithSnapshot: Tab = {
        ...tabNoPool,
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa04',
        items: [
          {
            ...tabNoPool.items[0]!,
            promotionId: 'cccccccc-dddd-eeee-ffff-000000000001',
            discountRate: 10,
            discountAmount: 1.3,
          },
          tabNoPool.items[1]!,
        ],
      };
      renderModal(tabWithSnapshot);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByTestId('line-item-discount-badge')).toBeInTheDocument();
      expect(within(dialog).getByTestId('line-item-discount-badge')).toHaveTextContent('10');
    });

    it('does not render a discount indicator when discountAmount is null', () => {
      renderModal(tabNoPool);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).queryByTestId('line-item-discount-badge')).not.toBeInTheDocument();
    });
  });
});
