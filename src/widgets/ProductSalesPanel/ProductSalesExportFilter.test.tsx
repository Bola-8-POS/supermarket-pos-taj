/**
 * QA test for AC-3 (POS-3): Export must export currently visible (filtered) rows.
 *
 * Bug: ProductSalesPanel passes `rawRows` (pre-filter) to ExportButtons instead of
 * `filtered` (the rows currently visible in the table). When a category filter is
 * active, the export includes all categories, not just the visible one.
 *
 * This test will FAIL until the implementation is fixed to pass `filtered` to ExportButtons.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProductSalesRow } from '@entities/tab/model/queries-reports';
import { renderWithProviders } from '@shared/lib/test-utils';
import { ProductSalesPanel } from './ProductSalesPanel';

// ---------------------------------------------------------------------------
// Capture what rows ExportButtons receives
// ---------------------------------------------------------------------------

const capturedExportRows: ProductSalesRow[][] = [];

vi.mock('@features/export-report', () => ({
  ExportButtons: ({ data }: { data: { rows: ProductSalesRow[]; dateRange: unknown } }) => {
    // Record the rows passed at render time
    capturedExportRows.push(data.rows);
    return <div data-testid="export-buttons" data-row-count={data.rows.length} />;
  },
}));

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
    productId: 'p-beer',
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
    productId: 'p-cocktail',
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
    productId: 'p-food',
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
// AC-3 test
// ---------------------------------------------------------------------------

describe('ProductSalesPanel — AC-3: export uses filtered rows (QA)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExportRows.length = 0;
  });

  it('AC-3: ExportButtons receives only filtered rows when category filter "Beer" is active', () => {
    mockUseProductSalesReport.mockReturnValue({
      data: { ok: true, data: threeProducts },
      isLoading: false,
    });

    renderWithProviders(<ProductSalesPanel dateRange={dateRange} />);

    // Verify all 3 products are initially visible
    expect(screen.getByText('Corona')).toBeInTheDocument();
    expect(screen.getByText('Jack & Coke')).toBeInTheDocument();
    expect(screen.getByText('Nachos')).toBeInTheDocument();

    // Apply the Beer category filter
    const select = screen.getByRole('combobox', { name: /filter by category/i });
    fireEvent.change(select, { target: { value: 'Beer' } });

    // After filter: only Corona should be visible in the table
    expect(screen.getByText('Corona')).toBeInTheDocument();
    expect(screen.queryByText('Jack & Coke')).not.toBeInTheDocument();
    expect(screen.queryByText('Nachos')).not.toBeInTheDocument();

    // AC-3: The ExportButtons MUST receive only the 1 visible Beer row.
    // Current implementation passes rawRows (3 items) — this assertion will FAIL.
    const exportEl = screen.getByTestId('export-buttons');
    const rowCount = Number(exportEl.getAttribute('data-row-count'));
    expect(rowCount).toBe(1); // Only the Beer row should be exported
  });
});
