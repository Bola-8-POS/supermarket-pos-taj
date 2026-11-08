import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Payment } from '@entities/payment';
import { usePayments } from '@entities/payment';
import { useStaffStore } from '@entities/staff/model/store';
import { useTabs } from '@entities/tab/model/queries';
import type { Tab } from '@entities/tab/model/types';
import { renderWithProviders } from '@shared/lib/test-utils';

import { PaymentPane } from './PaymentPane';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@entities/tab/model/queries', () => ({
  useTabs: vi.fn(),
  // EditPaidTabDialog (rendered unconditionally by PaymentPane since 22-03)
  // calls useTab(tabId ?? '') — stub it so mounting the dialog with a null
  // target doesn't hit the real Supabase client.
  useTab: vi.fn().mockReturnValue({
    data: undefined,
    isLoading: false,
    resultError: undefined,
    isEmpty: false,
    isIdleOrLoading: false,
  }),
  tabKeys: {
    all: ['tabs'] as const,
    lists: () => ['tabs', 'list'] as const,
    list: () => ['tabs', 'list', {}] as const,
    details: () => ['tabs', 'detail'] as const,
    detail: (id: string) => ['tabs', 'detail', id] as const,
  },
  // EditReopenedItemsPanel (rendered unconditionally by PaymentPane since
  // 09-01, mirroring EditPaidTabDialog) calls useAddItemToTab(), which wraps
  // useMutationAddOrder() — stub it so mounting the panel with a null target
  // doesn't hit the real Supabase client.
  useMutationAddOrder: vi.fn().mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

// EditPaidTabDialog (rendered unconditionally by PaymentPane since 22-03)
// calls useProducts() for the "Add item" picker — stub it so mounting the
// dialog with a null target doesn't hit the real Supabase client.
vi.mock('@entities/product', () => ({
  useProducts: vi.fn().mockReturnValue({ data: [], isLoading: false }),
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: vi.fn(),
}));

vi.mock('@entities/payment', () => ({
  usePayments: vi.fn().mockReturnValue({ data: [], isLoading: false }),
  useOrderItemsByPayment: vi.fn().mockReturnValue({ data: [], isLoading: false }),
}));

vi.mock('@entities/refund', () => ({
  useRefundsByPayment: vi.fn().mockReturnValue({ data: [] }),
}));

// PaymentHistoryList now reads settings for per-method payment labels — stub
// it so mounting PaymentPane doesn't hit the real Supabase-backed query hook.
vi.mock('@entities/settings', () => ({
  useSettings: () => ({ data: undefined }),
  useReceiptSettings: () => ({ data: undefined }),
}));

// ManagerPinDialog: expose a simplified version that calls onSuccess immediately
// when the test fires a click on the "Verify PIN" sentinel button, without
// requiring a real keypad interaction.
const mockOnSuccess = vi.fn();
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: ({
    open,
    onSuccess,
    onOpenChange,
  }: {
    open: boolean;
    onSuccess: () => void;
    onOpenChange: (v: boolean) => void;
  }) => {
    // stash latest onSuccess so tests can invoke it
    mockOnSuccess.mockImplementation(onSuccess);
    if (!open) return null;
    return (
      <div role="alertdialog" aria-label="Manager Access Required">
        <button
          type="button"
          onClick={() => {
            onSuccess();
          }}
        >
          Simulate PIN success
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          Cancel
        </button>
      </div>
    );
  },
}));

// PaymentForm: a lightweight stub so PaymentPane logic can be tested without
// the full payment form tree (which requires settings, processors, etc.)
const mockOnPaymentSuccess = vi.fn();
const mockOnClose = vi.fn();
vi.mock('@widgets/PaymentModal', () => ({
  PaymentForm: ({
    tab,
    onPaymentSuccess,
    onClose,
  }: {
    tab: Tab;
    staffId: string;
    onPaymentSuccess: () => void;
    onClose: () => void;
  }) => {
    mockOnPaymentSuccess.mockImplementation(onPaymentSuccess);
    mockOnClose.mockImplementation(onClose);
    return <div data-testid="payment-form">PaymentForm for {tab.customerName}</div>;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StoreState = Parameters<Parameters<typeof useStaffStore>[0]>[0];
const mockStoreState =
  (partial: Partial<StoreState>) =>
  (fn: (s: StoreState) => unknown): unknown =>
    fn(partial as StoreState);

const mockStaff = {
  id: 'staff-001',
  name: 'Test Manager',
  email: 'manager@example.com',
  role: 'manager' as const,
  pin: '789012',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX' as const,
};

function makeTab(overrides: Partial<Tab> & { id: string; customerName: string }): Tab {
  return {
    id: overrides.id,
    customerName: overrides.customerName,
    staffId: 'staff-001',
    shiftId: 'shift-001',
    openedAt: new Date(Date.now() - 30 * 60 * 1000),
    closedAt: null,
    status: 'open',
    notes: null,
    orders: [],
    items: overrides.items ?? [],
    subtotal: overrides.subtotal ?? 0,
    rappiOrderId: overrides.rappiOrderId ?? null,
  };
}

function mockTabsLoaded(tabs: Tab[]) {
  vi.mocked(useTabs).mockReturnValue({
    data: tabs,
    isIdleOrLoading: false,
    resultError: undefined,
  } as ReturnType<typeof useTabs>);
}

function mockTabsLoading() {
  vi.mocked(useTabs).mockReturnValue({
    data: undefined,
    isIdleOrLoading: true,
    resultError: undefined,
  } as ReturnType<typeof useTabs>);
}

function makePayment(overrides: Partial<Payment> & { id: string; tabId: string }): Payment {
  return {
    id: overrides.id,
    tabId: overrides.tabId,
    amount: overrides.amount ?? 100,
    method: overrides.method ?? 'cash',
    squarePaymentId: null,
    squareReceiptUrl: null,
    processedAt: overrides.processedAt ?? new Date('2026-08-01T12:00:00.000Z'),
    processedBy: 'staff-001',
    isRefund: overrides.isRefund ?? false,
    status: overrides.status ?? 'completed',
  };
}

function mockPaymentsLoaded(payments: Payment[]) {
  vi.mocked(usePayments).mockReturnValue({
    data: payments,
    isLoading: false,
  } as ReturnType<typeof usePayments>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useStaffStore).mockImplementation(mockStoreState({ currentStaff: mockStaff }));
    mockTabsLoaded([]);
  });

  // ── 1. Initial state ──────────────────────────────────────────────────────
  it('renders left panel header and right empty-state when no tab is selected', () => {
    const tabA = makeTab({ id: 'tab-1', customerName: 'Alice' });
    mockTabsLoaded([tabA]);
    renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

    expect(screen.getByText(/tabs awaiting payment/i)).toBeInTheDocument();
    // No tab selected → shows payment history empty state
    expect(screen.getByText(/no payment records found/i)).toBeInTheDocument();
    // No payment form visible yet
    expect(screen.queryByTestId('payment-form')).not.toBeInTheDocument();
  });

  // ── 2. Tab selection ──────────────────────────────────────────────────────
  it('clicking a TabPaymentCard selects the tab and shows PIN-verification prompt', async () => {
    const user = userEvent.setup();
    const tabA = makeTab({ id: 'tab-1', customerName: 'Bob' });
    mockTabsLoaded([tabA]);
    renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: /tab Bob/i }));

    // Right panel header should show customer name
    expect(screen.getByRole('heading', { name: 'Bob' })).toBeInTheDocument();
    // PIN verification button appears
    expect(
      screen.getByRole('button', { name: /verify pin to process payment/i })
    ).toBeInTheDocument();
    // Still no PaymentForm
    expect(screen.queryByTestId('payment-form')).not.toBeInTheDocument();
  });

  // ── 5. PIN gate flow — dialog opens then success shows PaymentForm ─────────
  it('clicking Verify PIN opens ManagerPinDialog; on PIN success PaymentForm renders', async () => {
    const user = userEvent.setup();
    const tabA = makeTab({ id: 'tab-1', customerName: 'Eve' });
    mockTabsLoaded([tabA]);
    renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: /tab Eve/i }));
    await user.click(screen.getByRole('button', { name: /verify pin to process payment/i }));

    // ManagerPinDialog stub should be visible
    await waitFor(() => {
      expect(
        screen.getByRole('alertdialog', { name: /manager access required/i })
      ).toBeInTheDocument();
    });

    // Simulate PIN success
    await user.click(screen.getByRole('button', { name: /simulate pin success/i }));

    // PaymentForm should now be visible
    await waitFor(() => {
      expect(screen.getByTestId('payment-form')).toBeInTheDocument();
    });
    expect(screen.getByText(/paymentform for Eve/i)).toBeInTheDocument();
  });

  // ── 6. Payment success resets selection ───────────────────────────────────
  it('after onPaymentSuccess fires, right panel returns to empty state', async () => {
    const user = userEvent.setup();
    const tabA = makeTab({ id: 'tab-1', customerName: 'Frank' });
    mockTabsLoaded([tabA]);
    renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

    // Select tab → PIN success → PaymentForm visible
    await user.click(screen.getByRole('button', { name: /tab Frank/i }));
    await user.click(screen.getByRole('button', { name: /verify pin to process payment/i }));
    await user.click(screen.getByRole('button', { name: /simulate pin success/i }));
    await waitFor(() => {
      expect(screen.getByTestId('payment-form')).toBeInTheDocument();
    });

    // Fire payment success (invalidates query) then close (clears selection)
    mockOnPaymentSuccess();
    mockOnClose();

    await waitFor(() => {
      // After clearing selection, shows payment history empty state
      expect(
        screen.getByText(/no payment records found/i)
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId('payment-form')).not.toBeInTheDocument();
  });

  // ── 7. Back button clears selection ───────────────────────────────────────
  it('clicking Back to tab list button clears the selected tab', async () => {
    const user = userEvent.setup();
    const tabA = makeTab({ id: 'tab-1', customerName: 'Grace' });
    mockTabsLoaded([tabA]);
    renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: /tab Grace/i }));
    // Right panel header is showing
    expect(screen.getByRole('heading', { name: 'Grace' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back to tab list/i }));

    await waitFor(() => {
      // After clearing selection, shows payment history empty state
      expect(
        screen.getByText(/no payment records found/i)
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Grace' })).not.toBeInTheDocument();
  });

  // ── 8. Selecting a different tab resets pin verified state ────────────────
  it('switching from one tab to another resets pinVerified and shows PIN prompt again', async () => {
    const user = userEvent.setup();
    const tabA = makeTab({ id: 'tab-1', customerName: 'Hannah' });
    const tabB = makeTab({ id: 'tab-2', customerName: 'Ivan' });
    mockTabsLoaded([tabA, tabB]);
    renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

    // Select first tab and verify PIN
    await user.click(screen.getByRole('button', { name: /tab Hannah/i }));
    await user.click(screen.getByRole('button', { name: /verify pin to process payment/i }));
    await user.click(screen.getByRole('button', { name: /simulate pin success/i }));
    await waitFor(() => {
      expect(screen.getByTestId('payment-form')).toBeInTheDocument();
    });

    // Select second tab — PIN state should reset
    await user.click(screen.getByRole('button', { name: /tab Ivan/i }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /verify pin to process payment/i })
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId('payment-form')).not.toBeInTheDocument();
  });

  // ── 9. Loading skeleton ───────────────────────────────────────────────────
  it('shows skeleton while tabs are loading', () => {
    mockTabsLoading();
    renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

    // When loading, no tab cards are rendered (skeleton is shown instead)
    // The empty-state text should also be absent
    expect(screen.queryByText(/no tabs waiting for payment/i)).not.toBeInTheDocument();
  });

  // ── 10. Empty state ───────────────────────────────────────────────────────
  it('shows "No tabs waiting for payment" when there are no open tabs', () => {
    mockTabsLoaded([]);
    renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

    expect(screen.getByText(/no tabs waiting for payment/i)).toBeInTheDocument();
  });

  // ── 11. ?id= query param seeds the filter and shows only the matching row ──
  it('seeds the ID filter from ?id= and shows only the matching payment row', () => {
    const paymentA = makePayment({ id: 'payment-aaa', tabId: 'tab-1' });
    const paymentB = makePayment({ id: 'payment-bbb', tabId: 'tab-2' });
    mockPaymentsLoaded([paymentA, paymentB]);
    renderWithProviders(
      <MemoryRouter initialEntries={['/payments?id=payment-aaa']}>
        <PaymentPane />
      </MemoryRouter>
    );

    expect(screen.getByTestId('payment-row-payment-aaa')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-row-payment-bbb')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/filter by id/i)).toHaveValue('payment-aaa');
  });

  // ── 12. Day-grouped history: today/refund tiles, ordering, method filters ──
  describe('payment history: tiles, day ordering, and method filters', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    function loadFixture() {
      const cash1 = makePayment({
        id: 'payment-cash-1',
        tabId: 'tab-1',
        amount: 100,
        method: 'cash',
        processedAt: new Date(),
      });
      const cash2 = makePayment({
        id: 'payment-cash-2',
        tabId: 'tab-2',
        amount: 50,
        method: 'cash',
        processedAt: new Date(),
      });
      const card1 = makePayment({
        id: 'payment-card-1',
        tabId: 'tab-3',
        amount: 30,
        method: 'card',
        processedAt: yesterday,
      });
      const refund1 = makePayment({
        id: 'payment-refund-1',
        tabId: 'tab-1',
        amount: -20,
        method: 'cash',
        isRefund: true,
        processedAt: new Date(),
      });
      mockPaymentsLoaded([cash1, cash2, card1, refund1]);
      return { cash1, cash2, card1, refund1 };
    }

    it('shows the Today tile sum/count for non-refund payments and the Refunds-today tile for refunds', () => {
      loadFixture();
      renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

      // Scope each tile's assertions to its own card — individual payment
      // rows below render the same "20.00" text as the refund tile's total,
      // so a page-wide getByText would be ambiguous.
      const todayTile = screen.getByText('Today', { selector: 'p' }).closest('div');
      const refundTile = screen.getByText('Refunds today', { selector: 'p' }).closest('div');
      expect(todayTile).not.toBeNull();
      expect(refundTile).not.toBeNull();

      expect(within(todayTile as HTMLElement).getByText(/150\.00/)).toBeInTheDocument();
      expect(within(todayTile as HTMLElement).getByText(/2 payments/i)).toBeInTheDocument();
      expect(within(refundTile as HTMLElement).getByText(/20\.00/)).toBeInTheDocument();
      expect(within(refundTile as HTMLElement).getByText(/1 payment\b/i)).toBeInTheDocument();
    });

    it('renders a Today day header before a Yesterday day header', () => {
      loadFixture();
      renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

      // Scope by accessible name to the two day-group headers specifically —
      // the left panel's empty-state ("No tabs waiting for payment") is also
      // an <h3> (via the shared EmptyState component) and would otherwise be
      // picked up as headings[0].
      const headings = screen.getAllByRole('heading', { level: 3, name: /^(today|yesterday)$/i });
      expect(headings).toHaveLength(2);
      expect(headings[0]).toHaveTextContent(/today/i);
      expect(headings[1]).toHaveTextContent(/yesterday/i);
    });

    it('clicking the Refunds filter chip shows only the refund row', async () => {
      const user = userEvent.setup();
      const { cash1, cash2, refund1 } = loadFixture();
      renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

      const refundsChip = screen.getByRole('button', { name: 'Refunds', pressed: false });
      await user.click(refundsChip);

      expect(screen.getByRole('button', { name: 'Refunds', pressed: true })).toBeInTheDocument();
      expect(screen.getByTestId(`payment-row-${refund1.id}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`payment-row-${cash1.id}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`payment-row-${cash2.id}`)).not.toBeInTheDocument();
    });

    it('clicking the Card filter chip shows only the card row', async () => {
      const user = userEvent.setup();
      const { cash1, cash2, card1, refund1 } = loadFixture();
      renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

      await user.click(screen.getByRole('button', { name: 'Card', pressed: false }));

      expect(screen.getByTestId(`payment-row-${card1.id}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`payment-row-${cash1.id}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`payment-row-${cash2.id}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`payment-row-${refund1.id}`)).not.toBeInTheDocument();
    });

    it('discloses the 100-payment query cap under the tiles, and hides it below that count', () => {
      const hundredPayments = Array.from({ length: 100 }, (_, i) =>
        makePayment({ id: `payment-${String(i)}`, tabId: `tab-${String(i)}` })
      );
      mockPaymentsLoaded(hundredPayments);
      const { rerender } = renderWithProviders(<MemoryRouter><PaymentPane /></MemoryRouter>);

      expect(screen.getByText(/based on the 100 most recent payments/i)).toBeInTheDocument();

      mockPaymentsLoaded([
        makePayment({ id: 'payment-a', tabId: 'tab-a' }),
        makePayment({ id: 'payment-b', tabId: 'tab-b' }),
        makePayment({ id: 'payment-c', tabId: 'tab-c' }),
      ]);
      rerender(<MemoryRouter><PaymentPane /></MemoryRouter>);

      expect(screen.queryByText(/based on the .* most recent payments/i)).not.toBeInTheDocument();
    });
  });

});
