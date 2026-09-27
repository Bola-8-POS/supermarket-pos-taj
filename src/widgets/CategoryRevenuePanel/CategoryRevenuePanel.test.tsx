/**
 * RTL component tests for CategoryRevenuePanel.
 * Mocks useCategoryRevenueReport to isolate rendering logic.
 */

import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as QueriesReports from '@entities/tab/model/queries-reports';
import { type CategoryRevenueRow } from '@entities/tab/model/queries-reports';
import { renderWithProviders } from '@shared/lib/test-utils';
import { CategoryRevenuePanel } from './CategoryRevenuePanel';

// ---------------------------------------------------------------------------
// Mock the queries-reports module
// ---------------------------------------------------------------------------

const mockUseCategoryRevenueReport = vi.fn();

vi.mock('@entities/tab/model/queries-reports', async importOriginal => {
  const actual = await importOriginal<typeof QueriesReports>();
  return {
    ...actual,
    useCategoryRevenueReport: () => mockUseCategoryRevenueReport(),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleRows: CategoryRevenueRow[] = [
  {
    categoryId: 'cat-1',
    categoryName: 'Beer',
    unitsSold: 50,
    orderCount: 30,
    revenue: 250.0,
    pctTotal: 62.5,
  },
  {
    categoryId: 'cat-2',
    categoryName: 'Cocktails',
    unitsSold: 20,
    orderCount: 15,
    revenue: 150.0,
    pctTotal: 37.5,
  },
];

const dateRange = { from: new Date('2026-04-20T00:00:00'), to: new Date('2026-04-20T23:59:59') };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CategoryRevenuePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading spinner when isLoading is true', () => {
    mockUseCategoryRevenueReport.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    renderWithProviders(<CategoryRevenuePanel dateRange={dateRange} />);

    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  it('renders zero-revenue rows with $0.00 and 0% when categories have no sales', () => {
    const zeroRows: CategoryRevenueRow[] = [
      {
        categoryId: 'pool',
        categoryName: 'Pool',
        unitsSold: 0,
        orderCount: 0,
        revenue: 0,
        pctTotal: 0,
      },
      {
        categoryId: 'beer',
        categoryName: 'Beer',
        unitsSold: 0,
        orderCount: 0,
        revenue: 0,
        pctTotal: 0,
      },
      {
        categoryId: 'cocktails',
        categoryName: 'Cocktails',
        unitsSold: 0,
        orderCount: 0,
        revenue: 0,
        pctTotal: 0,
      },
    ];
    mockUseCategoryRevenueReport.mockReturnValue({
      data: { ok: true, data: zeroRows },
      isLoading: false,
    });

    renderWithProviders(<CategoryRevenuePanel dateRange={dateRange} />);

    // All three canonical buckets appear — no empty state
    expect(screen.queryByText('No category data')).not.toBeInTheDocument();
    expect(screen.getByText('Pool')).toBeInTheDocument();
    expect(screen.getByText('Beer')).toBeInTheDocument();
    expect(screen.getByText('Cocktails')).toBeInTheDocument();
    // All pctTotal values are 0%
    const pctCells = screen.getAllByText('0%');
    expect(pctCells).toHaveLength(3);
  });

  it('renders correct number of table rows when data is present', () => {
    mockUseCategoryRevenueReport.mockReturnValue({
      data: { ok: true, data: sampleRows },
      isLoading: false,
    });

    renderWithProviders(<CategoryRevenuePanel dateRange={dateRange} />);

    const tbody = document.querySelector('tbody');
    expect(tbody).not.toBeNull();
    const rows = within(tbody as HTMLElement).getAllByRole('row');
    expect(rows).toHaveLength(sampleRows.length);
  });

  it('top row (idx=0) gets pos-highlight class', () => {
    mockUseCategoryRevenueReport.mockReturnValue({
      data: { ok: true, data: sampleRows },
      isLoading: false,
    });

    renderWithProviders(<CategoryRevenuePanel dateRange={dateRange} />);

    const tbody = document.querySelector('tbody') as HTMLElement;
    const rows = within(tbody).getAllByRole('row');
    expect(rows[0]?.className).toMatch(/brand/);
    expect(rows[1]?.className).not.toMatch(/brand/);
  });

  it('renders category name and pctTotal correctly', () => {
    mockUseCategoryRevenueReport.mockReturnValue({
      data: { ok: true, data: sampleRows },
      isLoading: false,
    });

    renderWithProviders(<CategoryRevenuePanel dateRange={dateRange} />);

    expect(screen.getByText('Beer')).toBeInTheDocument();
    expect(screen.getByText('Cocktails')).toBeInTheDocument();
    expect(screen.getByText('62.5%')).toBeInTheDocument();
    expect(screen.getByText('37.5%')).toBeInTheDocument();
  });
});
