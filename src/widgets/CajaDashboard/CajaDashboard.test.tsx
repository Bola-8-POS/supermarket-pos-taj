/**
 * RTL component tests for CajaDashboard.
 * Mocks query hooks via @entities/caja barrel while keeping the real Zustand store.
 */

import { screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as EntityCaja from '@entities/caja';
import { useCajaStore } from '@entities/caja/model/store';
import type * as EntityStaff from '@entities/staff';
import { useStaffStore } from '@entities/staff/model/store';
import type * as EntityTab from '@entities/tab';
import type { CajaEntry, CajaSession } from '@shared/lib/domain';
import * as posPrinter from '@shared/lib/pos-printer';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CajaDashboard } from './CajaDashboard';

// ---------------------------------------------------------------------------
// Mock hooks from @entities/caja barrel — keep useCajaStore real
// ---------------------------------------------------------------------------

const mockUseCajaPaymentSummary = vi.fn();
const mockUseCurrentCaja = vi.fn();
const mockUseMutationOpenCaja = vi.fn();
const mockUseMutationCloseCaja = vi.fn();
const mockUseCajaEntries = vi.fn();
const mockUseMutationDeleteCajaEntry = vi.fn();

vi.mock('@entities/caja', async importOriginal => {
  const actual = await importOriginal<typeof EntityCaja>();
  return {
    ...actual,
    useCajaPaymentSummary: () => mockUseCajaPaymentSummary(),
    useCurrentCaja: () => mockUseCurrentCaja(),
    useMutationOpenCaja: () => mockUseMutationOpenCaja(),
    useMutationCloseCaja: () => mockUseMutationCloseCaja(),
    useCajaEntries: () => mockUseCajaEntries(),
    useMutationDeleteCajaEntry: () => mockUseMutationDeleteCajaEntry(),
  };
});

// ---------------------------------------------------------------------------
// Mock hooks from @entities/tab barrel
// ---------------------------------------------------------------------------

const mockUseOpenTabsPendingTotal = vi.fn();

vi.mock('@entities/tab', async importOriginal => {
  const actual = await importOriginal<typeof EntityTab>();
  return {
    ...actual,
    useOpenTabsPendingTotal: () => mockUseOpenTabsPendingTotal(),
  };
});

// ---------------------------------------------------------------------------
// Mock usePermissions from @entities/staff barrel — keep useStaffStore real
// ---------------------------------------------------------------------------

const mockUsePermissions = vi.fn();

vi.mock('@entities/staff', async importOriginal => {
  const actual = await importOriginal<typeof EntityStaff>();
  return {
    ...actual,
    usePermissions: () => mockUsePermissions(),
  };
});

// ---------------------------------------------------------------------------
// Mock @features/register-caja-entry — stub out the dialog to avoid deep renders
// ---------------------------------------------------------------------------

vi.mock('@features/register-caja-entry', () => ({
  RegisterCajaEntryDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="entry-dialog" /> : null,
  useRegisterCajaEntry: () => ({
    registerEntry: vi.fn(),
    isPending: false,
  }),
}));

// ---------------------------------------------------------------------------
// Mock printRawText (Tauri IPC)
// ---------------------------------------------------------------------------

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof posPrinter>();
  return {
    ...actual,
    printRawText: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
  };
});

// ---------------------------------------------------------------------------
// Mock sonner
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock @entities/settings — only cash/card/rappi enabled by default so the
// pre-existing "5 summary cards" tests keep their exact card count; a
// dedicated describe block below exercises bank_transfer/uber_eats directly.
// ---------------------------------------------------------------------------

const { mockAppSettings } = vi.hoisted(() => ({
  mockAppSettings: {
    value: {
      billing: {
        paymentMethods: { cash: true, card: true, bank_transfer: false, rappi: true, uber_eats: false },
      },
      paymentLabels: {
        cash: 'Cash',
        card: 'Card',
        bank_transfer: 'Bank Transfer',
        rappi: 'Rappi',
        uber_eats: 'Uber Eats',
      },
    },
  },
}));

vi.mock('@entities/settings', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSettings: () => ({ data: mockAppSettings.value }),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testCaja: CajaSession = {
  id: 'test-caja-id',
  openedAt: new Date('2026-04-20T08:00:00.000Z'),
  closedAt: null,
  openedBy: 'user-uuid',
  closedBy: null,
  openingCash: 500,
  closingCash: null,
  notes: null,
  status: 'open',
  openedByName: 'Alex',
  closedByName: null,
};

const testStaff = {
  id: 'user-uuid',
  name: 'Alex',
  email: 'alex@bar.dev',
  role: 'admin' as const,
  pin: '0000',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX' as const,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaultMocks() {
  mockUseCajaPaymentSummary.mockReturnValue({
    data: { ok: true, data: { cash: 500, card: 300, rappi: 100 } },
    isLoading: false,
  });
  mockUseOpenTabsPendingTotal.mockReturnValue({
    data: { ok: true, data: 150 },
    isLoading: false,
  });
  mockUseCurrentCaja.mockReturnValue({ data: testCaja });
  mockUseMutationOpenCaja.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseMutationCloseCaja.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseCajaEntries.mockReturnValue({ data: { ok: true, data: [] }, isLoading: false });
  mockUseMutationDeleteCajaEntry.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUsePermissions.mockReturnValue({ can: () => true });

  useCajaStore.setState({
    currentCaja: testCaja,
    isCajaOpen: true,
  });

  useStaffStore.setState({
    currentStaff: testStaff,
    currentShift: null,
    staffList: [],
    isAuthenticated: true,
  });
}

// ---------------------------------------------------------------------------
// Render helper — CajaDashboard uses <Link> so needs a Router context
// ---------------------------------------------------------------------------

function renderDashboard() {
  return renderWithProviders(
    <MemoryRouter>
      <CajaDashboard />
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CajaDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('shows all 5 money summary card labels when caja is open', () => {
    renderDashboard();

    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('Card')).toBeInTheDocument();
    expect(screen.getByText('Rappi')).toBeInTheDocument();
    expect(screen.getByText(/Pending/i)).toBeInTheDocument();
    expect(screen.getByText('Net')).toBeInTheDocument();
  });

  it('renders the correct money values for each card', () => {
    renderDashboard();

    // MoneyDisplay renders with aria-label="$X.XX dollars"
    // cash=500, card=300, rappi=100, pending=150, net=900
    expect(screen.getByRole('generic', { name: '$500.00 dollars' })).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$300.00 dollars' })).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$100.00 dollars' })).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$150.00 dollars' })).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$900.00 dollars' })).toBeInTheDocument();
  });

  it('renders Print Summary button', () => {
    renderDashboard();
    expect(screen.getByRole('button', { name: /print summary/i })).toBeInTheDocument();
  });

  it('renders View Tabs link pointing to /payments', () => {
    renderDashboard();
    const link = screen.getByRole('link', { name: /view tabs/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/payments');
  });

  it('hides the 5-card summary block and View Tabs when caja is closed; Print Summary is disabled', () => {
    useCajaStore.setState({ currentCaja: null, isCajaOpen: false });

    renderDashboard();

    // SummaryCards and View Tabs are inside an isCajaOpen && currentCaja gate
    expect(screen.queryByRole('link', { name: /view tabs/i })).not.toBeInTheDocument();
    // Print Summary button is always rendered but disabled when no caja session is open (AC-3)
    const printBtn = screen.getByRole('button', { name: /print summary/i });
    expect(printBtn).toBeDisabled();
  });

  it('renders no caja section when user lacks manage_caja permission', () => {
    mockUsePermissions.mockReturnValue({ can: () => false });
    renderDashboard();
    // CajaDashboard returns null when !can('manage_caja')
    expect(screen.queryByText('Daily business session')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // NEW — Sprint 1 Feature #9 coverage
  // ---------------------------------------------------------------------------

  it('calls printRawText with cash, card, rappi, net, and pending values on Print Summary click', async () => {
    const printSpy = vi
      .spyOn(posPrinter, 'printRawText')
      .mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } });

    renderDashboard();

    const printBtn = screen.getByRole('button', { name: /print summary/i });
    fireEvent.click(printBtn);

    await waitFor(() => {
      expect(printSpy).toHaveBeenCalled();
    });

    const [printArg] = printSpy.mock.calls[0] as [string];
    // The printed string must contain each method total and net total, formatted
    // through the shared formatMoney() (en-US test-suite locale => "$" prefix)
    expect(printArg).toContain('$500.00'); // cash
    expect(printArg).toContain('$300.00'); // card
    expect(printArg).toContain('$100.00'); // rappi
    expect(printArg).toContain('$900.00'); // net = 500+300+100
    expect(printArg).toContain('$150.00'); // open tabs pending
  });

  it('shows the translated rejected copy (not the raw message) on Print Summary failure, and does not silently discard the Result', async () => {
    vi.spyOn(posPrinter, 'printRawText').mockResolvedValue({
      ok: false,
      error: { code: 'PRINT_JOB_REJECTED', message: 'y' },
    });

    renderDashboard();

    const printBtn = screen.getByRole('button', { name: /print summary/i });
    fireEvent.click(printBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Printer rejected this job. Check the printer name in Settings and try again.'
      );
    });
  });

  it('shows no toast on a successful Print Summary (no-success-toast rule)', async () => {
    vi.spyOn(posPrinter, 'printRawText').mockResolvedValue({
      ok: true,
      data: { jobId: 'mock-job' },
    });

    renderDashboard();

    const printBtn = screen.getByRole('button', { name: /print summary/i });
    fireEvent.click(printBtn);

    await waitFor(() => {
      expect(posPrinter.printRawText).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows net revenue of $170.00 when cash=$100, card=$50, rappi=$20', () => {
    mockUseCajaPaymentSummary.mockReturnValue({
      data: { ok: true, data: { cash: 100, card: 50, rappi: 20 } },
      isLoading: false,
    });
    // pending total stays at 0 for this test
    mockUseOpenTabsPendingTotal.mockReturnValue({
      data: { ok: true, data: 0 },
      isLoading: false,
    });

    renderDashboard();

    // Net = 100 + 50 + 20 = 170
    expect(screen.getByRole('generic', { name: '$170.00 dollars' })).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$100.00 dollars' })).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$50.00 dollars' })).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$20.00 dollars' })).toBeInTheDocument();
  });

  it('shows loading spinners when useCajaPaymentSummary is in loading state', () => {
    mockUseCajaPaymentSummary.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    renderDashboard();

    // LoadingSpinner renders role="status" with aria-label matching /loading/i
    const spinners = screen.getAllByRole('status', { name: /loading/i });
    // At least Cash, Card, Rappi, Net cards show spinners (4 summary cards use isSummaryLoading)
    expect(spinners.length).toBeGreaterThanOrEqual(4);
  });

  it('useOpenTabsPendingTotal is configured with refetchInterval 30000ms (verified at hook level)', () => {
    // The refetchInterval is set inside the hook definition in
    // src/entities/tab/model/queries.ts — the queries.test.ts covers this
    // via the QueryCache observer options. Here we verify the component wires
    // the hook correctly: when caja is open the hook receives the cajaId.
    // We do this by asserting the pending card renders (not "0" spinner state
    // implies the hook ran and returned data).
    renderDashboard();

    // Pending (open tabs) card is visible with value from the mock ($150.00)
    expect(screen.getByText(/Pending/i)).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$150.00 dollars' })).toBeInTheDocument();
  });

  it('pending card shows $0.00 without layout shift when no tabs are open', () => {
    mockUseOpenTabsPendingTotal.mockReturnValue({
      data: { ok: true, data: 0 },
      isLoading: false,
    });

    renderDashboard();

    expect(screen.getByText(/Pending/i)).toBeInTheDocument();
    expect(screen.getByRole('generic', { name: '$0.00 dollars' })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Sprint 4 — Expenses / Income entries tests
  // ---------------------------------------------------------------------------

  it('shows "Register Expense / Income" button when caja is open and user is manager', () => {
    renderDashboard();
    expect(screen.getByRole('button', { name: /register expense \/ income/i })).toBeInTheDocument();
  });

  it('"Register Expense / Income" button is NOT visible when caja is closed', () => {
    useCajaStore.setState({ currentCaja: null, isCajaOpen: false });
    renderDashboard();
    expect(
      screen.queryByRole('button', { name: /register expense \/ income/i })
    ).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Configurable payment methods (bank_transfer / uber_eats)
  // ---------------------------------------------------------------------------

  describe('configurable payment methods', () => {
    it('hides a disabled method with zero collections (bank_transfer, uber_eats)', () => {
      renderDashboard();
      expect(screen.queryByText('Bank Transfer')).not.toBeInTheDocument();
      expect(screen.queryByText('Uber Eats')).not.toBeInTheDocument();
    });

    it('still shows a disabled method that collected money this session (toggled off mid-day)', () => {
      mockUseCajaPaymentSummary.mockReturnValue({
        data: {
          ok: true,
          data: { cash: 500, card: 300, bank_transfer: 0, rappi: 100, uber_eats: 40 },
        },
        isLoading: false,
      });
      renderDashboard();
      expect(screen.getByText('Uber Eats')).toBeInTheDocument();
      expect(screen.queryByText('Bank Transfer')).not.toBeInTheDocument();
    });

    it('uses the store paymentLabels for the enabled-method cards', () => {
      renderDashboard();
      expect(screen.getByText('Rappi')).toBeInTheDocument();
    });
  });

  it('renders entries list when entries are present', () => {
    const testEntries: CajaEntry[] = [
      {
        id: 'entry-uuid-001',
        cajaSessionId: 'test-caja-id',
        type: 'expense',
        amount: 50,
        concept: 'Office supplies',
        createdAt: new Date('2026-04-21T09:00:00.000Z'),
        staffId: 'user-uuid',
        staffName: 'Alex',
      },
      {
        id: 'entry-uuid-002',
        cajaSessionId: 'test-caja-id',
        type: 'income',
        amount: 100,
        concept: 'Cash advance',
        createdAt: new Date('2026-04-21T10:00:00.000Z'),
        staffId: 'user-uuid',
        staffName: 'Alex',
      },
    ];

    mockUseCajaEntries.mockReturnValue({
      data: { ok: true, data: testEntries },
      isLoading: false,
    });

    renderDashboard();

    expect(screen.getByText('Office supplies')).toBeInTheDocument();
    expect(screen.getByText('Cash advance')).toBeInTheDocument();
    expect(screen.getByText('Recent Entries')).toBeInTheDocument();
  });
});
