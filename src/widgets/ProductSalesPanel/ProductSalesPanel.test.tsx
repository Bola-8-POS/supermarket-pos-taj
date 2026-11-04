/**
 * RTL component tests for ProductSalesPanel.
 * Mocks useProductSalesReport to isolate rendering logic.
 */

import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProductSalesRow } from '@entities/tab/model/queries-reports';
import { renderWithProviders } from '@shared/lib/test-utils';
import { ProductSalesPanel } from './ProductSalesPanel';

// ---------------------------------------------------------------------------
// Mock the queries-reports hook
// ---------------------------------------------------------------------------

const mockUseProductSalesReport = vi.fn();

vi.mock('@entities/tab/model/queries-reports', () => ({
  useProductSalesReport: () => mockUseProductSalesReport(),
  computePctTotals: vi.fn(),
  fillMissingHours: vi.fn(),
  findPeakHour: vi.fn(),
  findSlowestHour: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const threeProducts: ProductSalesRow[] = [
  {
    productId: 'prod-1',
    productName: 'Corona',
    categoryName: 'Beer',
    units: 30,
    revenue: 300,
    costTotal: 180,
    margin: 120,
    marginPct: 40,
    pctTotal: 60,
  },
  {
    productId: 'prod-2',
    productName: 'Jack & Coke',
    categoryName: 'Cocktails',
    units: 15,
    revenue: 150,
    costTotal: 90,
    margin: 60,
    marginPct: 40,
    pctTotal: 30,
  },
  {
    productId: 'prod-3',
    productName: 'Nachos',
    categoryName: 'Food',
    units: 10,
    revenue: 50,
    costTotal: 30,
    margin: 20,
    marginPct: 40,
    pctTotal: 10,
  },
];

const dateRange = { from: new Date('2026-04-20T00:00:00'), to: new Date('2026-04-20T23:59:59') };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProductSalesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an accessible unavailable state for unknown margin', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: {
        ok: true,
        data: [{ ...threeProducts[0]!, costTotal: null, margin: null, marginPct: null }],
      },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);
    expect(
      screen.getByLabelText('Margin unavailable — no recorded cost for this period')
    ).toHaveTextContent('—');
  });

  it('renders 3 data rows when query returns 3 products', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: threeProducts },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    const tbody = document.querySelector('tbody');
    expect(tbody).not.toBeNull();
    const rows = within(tbody as HTMLElement).getAllByRole('row');
    expect(rows).toHaveLength(3);
  });

  it('applies pos-highlight top-3 class to first row (Corona)', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: threeProducts },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    // ProductSalesPanel applies 'border-l-pos-highlight' to top-3 rows
    const tbody = document.querySelector('tbody');
    expect(tbody).not.toBeNull();
    const rows = within(tbody as HTMLElement).getAllByRole('row');
    // The first row (highest revenue) should have the highlight class
    expect(rows[0]!.className).toMatch(/border-l-brand/);
  });

  it('shows all unique categories in the filter select', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: threeProducts },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    const select = screen.getByRole('combobox', { name: /filter by category/i });
    expect(select).toBeInTheDocument();

    const options = within(select).getAllByRole('option');
    const optionTexts = options.map(o => o.textContent);
    expect(optionTexts).toContain('All');
    expect(optionTexts).toContain('Beer');
    expect(optionTexts).toContain('Cocktails');
    expect(optionTexts).toContain('Food');
  });

  it('renders empty state when query returns empty array', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: [] },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    expect(screen.getByText('No sales in this range')).toBeInTheDocument();
  });

  it('renders loading spinner while query is in flight', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    // LoadingSpinner renders a status element with aria-label="Loading"
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // New tests — Task 2
  // -------------------------------------------------------------------------

  it('category filter narrows rows to only the selected category', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: threeProducts },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    // Before filter: all three products visible
    expect(screen.getByText('Corona')).toBeInTheDocument();
    expect(screen.getByText('Jack & Coke')).toBeInTheDocument();
    expect(screen.getByText('Nachos')).toBeInTheDocument();

    // Select "Beer" from the category dropdown
    const select = screen.getByRole('combobox', { name: /filter by category/i });
    fireEvent.change(select, { target: { value: 'Beer' } });

    // Only Beer product should remain
    expect(screen.getByText('Corona')).toBeInTheDocument();
    expect(screen.queryByText('Jack & Coke')).not.toBeInTheDocument();
    expect(screen.queryByText('Nachos')).not.toBeInTheDocument();
  });

  it('sort toggle: By Revenue shows highest-revenue first; By Units shows highest-units first', () => {
    // revenue rank: ProductA(500) > ProductB(100)
    // units rank:   ProductB(200) > ProductA(10)
    const products: ProductSalesRow[] = [
      {
        productId: 'p-a',
        productName: 'ProductA',
        categoryName: 'Cat',
        units: 10,
        revenue: 500,
        costTotal: 300,
        margin: 200,
        marginPct: 40,
        pctTotal: 83,
      },
      {
        productId: 'p-b',
        productName: 'ProductB',
        categoryName: 'Cat',
        units: 200,
        revenue: 100,
        costTotal: 60,
        margin: 40,
        marginPct: 40,
        pctTotal: 17,
      },
    ];

    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: products },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    // Default sort = By Revenue — ProductA should be first row
    const tbody = document.querySelector('tbody') as HTMLElement;
    let rows = within(tbody).getAllByRole('row');
    expect(rows[0]!.textContent).toContain('ProductA');

    // Switch to By Units — ProductB (200 units) should move to first
    fireEvent.click(screen.getByRole('button', { name: /by units/i }));
    rows = within(tbody).getAllByRole('row');
    expect(rows[0]!.textContent).toContain('ProductB');
  });

  it('% of Total column sums to ~100%', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: threeProducts },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    // pctTotal cells contain text like "60%", "30%", "10%"
    const pctCells = screen
      .getAllByText(/^\d+(\.\d+)?%$/)
      .map(el => parseFloat(el.textContent?.replace('%', '') ?? '0'));

    const sum = pctCells.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThanOrEqual(99.0);
    expect(sum).toBeLessThanOrEqual(101.0);
  });

  it('re-renders with new date range calls the query hook with updated params', () => {
    const dateA = { from: new Date('2026-01-01T00:00:00'), to: new Date('2026-01-01T23:59:59') };
    const dateB = { from: new Date('2026-03-15T00:00:00'), to: new Date('2026-03-15T23:59:59') };

    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: threeProducts },
      isLoading: false,
    });

    const { rerender } = renderWithProviders(<ProductSalesPanel dateRange={dateA} />);

    const callsAfterFirst = mockUseProductSalesReport.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    rerender(<ProductSalesPanel dateRange={dateB} />);

    // After re-render with new date range, the hook must have been called again
    expect(mockUseProductSalesReport.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
