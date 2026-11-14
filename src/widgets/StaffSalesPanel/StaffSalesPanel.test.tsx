/**
 * RTL component tests for StaffSalesPanel.
 * Mocks useStaffMetrics and ExportButtons to isolate rendering behavior.
 *
 * AC verified:
 *   S10-03.1 — DataTable with columns: Staff Member, Revenue, Transactions, Avg Check, Voids
 *   S10-03.2 — ExportButtons shown when rows > 0
 *   S10-03.3 — LoadingSpinner shown while loading
 *   S10-03.4 — EmptyState shown when no data
 */

import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';
import { StaffSalesPanel } from './StaffSalesPanel';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockUseStaffMetrics = vi.fn();

vi.mock('@entities/staff', () => ({
  useStaffMetrics: () => mockUseStaffMetrics(),
}));

vi.mock('@features/export-report', () => ({
  ExportButtons: () => <button type="button">Export</button>,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dateRange = { from: new Date('2026-04-01T00:00:00'), to: new Date('2026-04-30T23:59:59') };

const staffRows = [
  {
    staffId: 'staff-1',
    staffName: 'Alice',
    revenue: 5000,
    transactionCount: 10,
    avgCheckSize: 500,
    voidCount: 1,
  },
  {
    staffId: 'staff-2',
    staffName: 'Bob',
    revenue: 3000,
    transactionCount: 6,
    avgCheckSize: 500,
    voidCount: 0,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StaffSalesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('S10-03.3 — shows LoadingSpinner while loading', () => {
    mockUseStaffMetrics.mockReturnValue({ data: undefined, isLoading: true });
    renderWithProviders(<StaffSalesPanel dateRange={dateRange} />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  it('S10-03.1 — renders DataTable with expected column headers', () => {
    mockUseStaffMetrics.mockReturnValue({ data: { ok: true, data: staffRows }, isLoading: false });
    renderWithProviders(<StaffSalesPanel dateRange={dateRange} />);

    expect(screen.getByText('Staff Member')).toBeInTheDocument();
    expect(screen.getByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Avg Check')).toBeInTheDocument();
    expect(screen.getByText('Voids')).toBeInTheDocument();
  });

  it('S10-03.1 — renders staff name rows', () => {
    mockUseStaffMetrics.mockReturnValue({ data: { ok: true, data: staffRows }, isLoading: false });
    renderWithProviders(<StaffSalesPanel dateRange={dateRange} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('S10-03.2 — shows ExportButtons when rows > 0', () => {
    mockUseStaffMetrics.mockReturnValue({ data: { ok: true, data: staffRows }, isLoading: false });
    renderWithProviders(<StaffSalesPanel dateRange={dateRange} />);

    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
  });

  it('S10-03.4 — shows EmptyState when result has zero rows', () => {
    mockUseStaffMetrics.mockReturnValue({ data: { ok: true, data: [] }, isLoading: false });
    renderWithProviders(<StaffSalesPanel dateRange={dateRange} />);

    expect(screen.getByText('No staff activity')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
  });

  it('S10-03.4 — shows EmptyState when result is undefined (no data fetched)', () => {
    mockUseStaffMetrics.mockReturnValue({ data: undefined, isLoading: false });
    renderWithProviders(<StaffSalesPanel dateRange={dateRange} />);

    expect(screen.getByText('No staff activity')).toBeInTheDocument();
  });

  it('S10-03.4 — shows EmptyState (no export button) when result is an error', () => {
    mockUseStaffMetrics.mockReturnValue({
      data: { ok: false, error: { code: 'SUPABASE_ERROR', message: 'fail' } },
      isLoading: false,
    });
    renderWithProviders(<StaffSalesPanel dateRange={dateRange} />);

    expect(screen.getByText('No staff activity')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
  });
});
