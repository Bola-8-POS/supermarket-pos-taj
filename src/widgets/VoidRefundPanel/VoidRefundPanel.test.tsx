/**
 * RTL component tests for VoidRefundPanel.
 * Mocks useVoidRefundReport to isolate rendering logic.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VoidRefundRow } from '@entities/tab/model/queries-reports';
import { renderWithProviders } from '@shared/lib/test-utils';
import { VoidRefundPanel } from './VoidRefundPanel';

// ---------------------------------------------------------------------------
// Mock the queries-reports hook
// ---------------------------------------------------------------------------

const mockUseVoidRefundReport = vi.fn();

vi.mock('@entities/tab/model/queries-reports', () => ({
  useVoidRefundReport: () => mockUseVoidRefundReport(),
  computePctTotals: vi.fn(),
  fillMissingHours: vi.fn(),
  findPeakHour: vi.fn(),
  findSlowestHour: vi.fn(),
  filterVoidRefundRows: vi.fn(),
}));

vi.mock('@features/export-report', () => ({
  ExportButtons: () => <button type="button">Export</button>,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const twoVoids: VoidRefundRow[] = [
  {
    orderId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    voidedAt: new Date('2026-04-21T14:30:00Z'),
    staffName: 'Alice',
    amount: 45.5,
    reason: 'Customer changed mind',
  },
  {
    orderId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    voidedAt: new Date('2026-04-21T18:00:00Z'),
    staffName: 'Bob',
    amount: 20.0,
    reason: 'Entered on wrong tab',
  },
];

const dateRange = { from: new Date('2026-04-21T00:00:00'), to: new Date('2026-04-21T23:59:59') };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoidRefundPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading spinner while fetching', () => {
    mockUseVoidRefundReport.mockReturnValue({ data: undefined, isLoading: true });
    renderWithProviders(<VoidRefundPanel dateRange={dateRange} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders void rows with staff name, amount, and reason', () => {
    mockUseVoidRefundReport.mockReturnValue({
      data: { ok: true, data: twoVoids },
      isLoading: false,
    });
    renderWithProviders(<VoidRefundPanel dateRange={dateRange} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Customer changed mind')).toBeInTheDocument();
    expect(screen.getByText('Entered on wrong tab')).toBeInTheDocument();
  });

  it('shows empty state when query returns zero rows', () => {
    mockUseVoidRefundReport.mockReturnValue({ data: { ok: true, data: [] }, isLoading: false });
    renderWithProviders(<VoidRefundPanel dateRange={dateRange} />);

    expect(screen.getByText('No voids or refunds')).toBeInTheDocument();
    expect(screen.getByText('No voids or refunds in this range.')).toBeInTheDocument();
  });

  it('shows empty state when query errors', () => {
    mockUseVoidRefundReport.mockReturnValue({
      data: { ok: false, error: { code: 'SUPABASE_ERROR', message: 'fail' } },
      isLoading: false,
    });
    renderWithProviders(<VoidRefundPanel dateRange={dateRange} />);
    expect(screen.getByText('No voids or refunds')).toBeInTheDocument();
  });
});
