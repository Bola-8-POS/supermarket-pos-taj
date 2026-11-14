/**
 * Phase 30 (CART-02): PaymentForm reopens from a persisted draft and reports only sanitized drafts.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

import type * as PromotionModule from '@entities/promotion';
import { useStaffStore } from '@entities/staff/model/store';
import { useCartStore } from '@entities/tab/model/cartStore';
import type { Tab } from '@entities/tab/model/types';
import type { CheckoutDraft } from '@shared/lib/domain';
import { calculateDiscountAmount } from '@shared/lib/domain-helpers';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import type * as PosPrinter from '@shared/lib/pos-printer';
import { ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';

import { PaymentForm, type PaymentProcessors } from './PaymentForm';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, ready: true }),
}));
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: (props: { open: boolean; onSuccess: (s: object, approvalId: string) => void }) =>
    props.open
      ? createElement(
          'button',
          {
            onClick: () => {
              props.onSuccess({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, 'ticket-1');
            },
          },
          'Grant PIN'
        )
      : null,
}));
vi.mock('@entities/promotion', async importOriginal => {
  const actual = await importOriginal<typeof PromotionModule>();
  return { ...actual, usePromotions: () => ({ data: [] }) };
});
vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return { ...actual, printReceipt: vi.fn(), openCashDrawer: vi.fn() };
});
vi.mock('@entities/settings', () => ({
  useSettings: () => ({
    data: {
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
    },
  }),
  useReceiptSettings: () => ({ data: undefined }),
}));

const staffId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
/** Two units at 10.00: the total is 20.00. */
const tab: Tab = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  customerName: 'T',
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

const processors = {
  processCashPayment: vi.fn().mockResolvedValue(ok({})),
  processCardPayment: vi.fn(),
  processPlatformPayment: vi.fn(),
  processSplitPayment: vi.fn(),
} as unknown as PaymentProcessors; // test double: only the processors this suite never calls

const draft = (over: Partial<CheckoutDraft> = {}): CheckoutDraft => ({
  method: 'cash',
  tenderedCents: 2500,
  splitLegs: [],
  discount: null,
  reference: null,
  ...over,
});

function renderForm(
  extra: {
    initialDraft?: CheckoutDraft;
    initialReceipt?: ReceiptData;
    onDraftChange?: (d: CheckoutDraft) => void;
    payBlockedReason?: string | undefined;
  } = {}
) {
  return renderWithProviders(
    <PaymentForm tab={tab} staffId={staffId} onPaymentSuccess={vi.fn()} processors={processors} {...extra} />
  );
}

beforeEach(() => {
  useStaffStore.setState({
    currentStaff: { id: staffId, name: 'M', role: 'manager', isActive: true, mustChangePin: false, locale: 'es-MX' },
    currentShift: null,
    staffList: [],
    isAuthenticated: true,
  });
});
afterEach(cleanup);

describe('PaymentForm restore (CART-02)', () => {
  it('with initialDraft shows the restored tendered amount after mount, not 0.00', () => {
    renderForm({ initialDraft: draft({ tenderedCents: 2500 }) });
    expect(screen.getByLabelText('Amount tendered')).toHaveValue('25.00');
  });

  it('with initialDraft shows split legs in persisted order', () => {
    renderForm({
      initialDraft: draft({
        splitLegs: [
          { method: 'card', amountCents: 500 },
          { method: 'cash', amountCents: 1500 },
        ],
      }),
    });
    const amounts = screen.getAllByLabelText('Amount');
    expect(amounts.map(a => (a as HTMLInputElement).value)).toEqual(['5.00', '15.00']);
  });

  it('with a restored custom discount requires a manager PIN before Pay', async () => {
    const user = userEvent.setup();
    renderForm({ initialDraft: draft({ tenderedCents: 2000, discount: { type: 'percent', value: 10 } }) });
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeDisabled();
    await user.click(screen.getByText(/grant pin/i));
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeEnabled();
  });

  it('restored discount amount equals the existing discount helper result', () => {
    renderForm({ initialDraft: draft({ tenderedCents: 2000, discount: { type: 'fixed', value: 350 } }) });
    expect(screen.getByLabelText('Discount amount')).toHaveValue('3.50');
    expect(screen.getByTestId('discount-applied-label')).toHaveTextContent(
      calculateDiscountAmount(20, 'fixed', 3.5).toFixed(2)
    );
  });

  it('onDraftChange receives only sanitized drafts', async () => {
    const user = userEvent.setup();
    const seen: CheckoutDraft[] = [];
    renderForm({ onDraftChange: d => seen.push(d) });
    await user.click(screen.getByTestId('quick-tender-exact'));
    const last = seen.at(-1);
    expect(Object.keys(last ?? {}).sort()).toEqual(['discount', 'method', 'reference', 'splitLegs', 'tenderedCents']);
    expect(last?.tenderedCents).toBe(2000);
    const json = JSON.stringify(seen);
    for (const forbidden of ['pin', 'approval', 'managerOverride', 'authorizingManager']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('never reports a card-number-shaped reference', async () => {
    const user = userEvent.setup();
    const seen: CheckoutDraft[] = [];
    renderForm({ onDraftChange: d => seen.push(d) });
    await user.click(screen.getByTestId('payment-btn-card'));
    await user.type(screen.getByLabelText(/reference/i), '4111111111111111');
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toContain('4111111');
  });
});

describe('PaymentForm payBlockedReason (D-03)', () => {
  it('disables Pay and shows payBlockedReason while it is set', async () => {
    const user = userEvent.setup();
    renderForm({ payBlockedReason: 'Review the changed items above before paying.' });
    await user.click(screen.getByTestId('quick-tender-exact'));
    const pay = screen.getByRole('button', { name: 'Process payment' });
    expect(pay).toBeDisabled();
    const reason = screen.getByText('Review the changed items above before paying.');
    expect(pay.getAttribute('aria-describedby')).toContain(reason.id);
  });

  it('enables Pay when payBlockedReason becomes undefined', async () => {
    const user = userEvent.setup();
    const view = renderForm({ payBlockedReason: 'blocked' });
    await user.click(screen.getByTestId('quick-tender-exact'));
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeDisabled();
    view.rerender(
      <PaymentForm tab={tab} staffId={staffId} onPaymentSuccess={vi.fn()} processors={processors} payBlockedReason={undefined} />
    );
    expect(screen.getByRole('button', { name: 'Process payment' })).toBeEnabled();
    expect(screen.queryByText('blocked')).toBeNull();
  });
});

const receipt = (): ReceiptData => ({
  receiptNumber: 'R001',
  tabId: tab.id,
  customerName: 'T',
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
});

describe('PaymentForm recovered receipt and offline marker (CART-04)', () => {
  it('initialReceipt renders the receipt step and never calls print', async () => {
    const { printReceipt, openCashDrawer } = await import('@shared/lib/pos-printer');
    renderForm({ initialReceipt: receipt() });
    expect(screen.queryByRole('button', { name: 'Process payment' })).toBeNull();
    expect(screen.getByText(/R001/)).toBeInTheDocument();
    expect(printReceipt).not.toHaveBeenCalled();
    expect(openCashDrawer).not.toHaveBeenCalled();
  });

  it('offline sell-instead acceptance clears the submission marker', async () => {
    const user = userEvent.setup();
    useCartStore.setState({ submission: { key: 'k-unknown', startedAt: 1 } });
    const processCardPayment = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'PAYMENT_OUTCOME_UNKNOWN', message: 'unknown' } })
      .mockResolvedValueOnce(ok({ receiptData: { ...receipt(), provisional: true } }));
    const offlineProcessors = {
      ...processors,
      processCardPayment,
      canSellOffline: () => true,
    } as unknown as PaymentProcessors; // test double: only the card path and the offline probe are exercised
    renderWithProviders(
      <PaymentForm tab={tab} staffId={staffId} onPaymentSuccess={vi.fn()} processors={offlineProcessors} />
    );
    await user.click(screen.getByTestId('payment-btn-card'));
    await user.click(screen.getByRole('button', { name: 'Confirm card payment' }));
    const dialog = await screen.findByRole('alertdialog');
    // the unknown-outcome dialog alone does not clear it
    expect(useCartStore.getState().submission).not.toBeNull();
    await user.click(within(dialog).getByRole('button', { name: /sell offline instead/i }));
    await waitFor(() => {
      expect(useCartStore.getState().submission).toBeNull();
    });
    expect(processCardPayment).toHaveBeenCalledTimes(2);
  });
});
