/**
 * Unit tests for VarianceReport
 *
 * AC covered (S8-06):
 * - Shows product name, expected stock, actual count, variance columns
 * - Negative variance row is highlighted red (bg-destructive/10)
 * - Zero variance row has no colour highlight class
 * - Positive variance row is highlighted green (bg-brand-soft)
 * - Empty-state message shown when rows is []
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PhysicalCountVarianceRow } from '../model/usePhysicalCount';
import { VarianceReport } from './VarianceReport';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<PhysicalCountVarianceRow> & { variance: number }
): PhysicalCountVarianceRow {
  return {
    productId: crypto.randomUUID(),
    productName: 'Test Product',
    expectedStock: 10,
    actualCount: 10 + overrides.variance,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds the <tr> that contains the given product name text.
 * shadcn Table renders rows as <tr> elements inside <tbody>.
 */
function getRowByProductName(name: string): HTMLElement {
  const cell = screen.getByText(name);
  // Walk up the DOM to the nearest <tr>
  let el: HTMLElement | null = cell;
  while (el && el.tagName.toLowerCase() !== 'tr') {
    el = el.parentElement;
  }
  if (!el) throw new Error(`Could not find <tr> parent for product "${name}"`);
  return el;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VarianceReport', () => {
  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  it('shows no-variance message when rows is empty', () => {
    render(<VarianceReport rows={[]} />);
    expect(screen.getByText(/no variance/i)).toBeInTheDocument();
    // Table should not render
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Column headers (S8-06: correct columns displayed)
  // -------------------------------------------------------------------------

  it('S8-06: renders Product, Expected, Actual, Variance column headers', () => {
    render(<VarianceReport rows={[makeRow({ variance: 0, productName: 'Beer' })]} />);
    expect(screen.getByText('Product')).toBeInTheDocument();
    expect(screen.getByText('Expected')).toBeInTheDocument();
    expect(screen.getByText('Actual')).toBeInTheDocument();
    expect(screen.getByText('Variance')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Row data
  // -------------------------------------------------------------------------

  it('S8-06: displays product name, expected stock, actual count, and variance for each row', () => {
    const rows: PhysicalCountVarianceRow[] = [
      { productId: '1', productName: 'Heineken', expectedStock: 20, actualCount: 15, variance: -5 },
      { productId: '2', productName: 'Coke', expectedStock: 10, actualCount: 10, variance: 0 },
      { productId: '3', productName: 'Rum', expectedStock: 5, actualCount: 8, variance: 3 },
    ];

    render(<VarianceReport rows={rows} />);

    // Product names
    expect(screen.getByText('Heineken')).toBeInTheDocument();
    expect(screen.getByText('Coke')).toBeInTheDocument();
    expect(screen.getByText('Rum')).toBeInTheDocument();

    // Variance values — negative shown as-is, positive prefixed with '+'
    expect(screen.getByText('-5')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('+3')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Negative variance → red highlight (S8-06 AC: row highlighted red)
  // -------------------------------------------------------------------------

  it('S8-06: negative variance row has bg-destructive/10 class', () => {
    render(<VarianceReport rows={[makeRow({ variance: -3, productName: 'Shortage Product' })]} />);

    const row = getRowByProductName('Shortage Product');
    expect(row.className).toContain('bg-destructive/10');
    expect(row.className).toContain('text-destructive');
  });

  it('S8-06: negative variance row does NOT have emerald (green) classes', () => {
    render(<VarianceReport rows={[makeRow({ variance: -1, productName: 'Short Beer' })]} />);

    const row = getRowByProductName('Short Beer');
    expect(row.className).not.toContain('bg-brand-soft');
  });

  // -------------------------------------------------------------------------
  // Zero variance → no highlight (S8-06 AC: zero variance row has no highlight)
  // -------------------------------------------------------------------------

  it('S8-06: zero variance row has neither red nor green highlight classes', () => {
    render(<VarianceReport rows={[makeRow({ variance: 0, productName: 'Exact Beer' })]} />);

    const row = getRowByProductName('Exact Beer');
    expect(row.className).not.toContain('bg-destructive');
    expect(row.className).not.toContain('bg-brand-soft');
    expect(row.className).not.toContain('text-destructive');
    expect(row.className).not.toContain('text-brand-strong');
  });

  // -------------------------------------------------------------------------
  // Positive variance → green highlight
  // -------------------------------------------------------------------------

  it('positive variance row has bg-brand-soft class', () => {
    render(<VarianceReport rows={[makeRow({ variance: 5, productName: 'Surplus Rum' })]} />);

    const row = getRowByProductName('Surplus Rum');
    expect(row.className).toContain('bg-brand-soft');
    expect(row.className).toContain('text-brand-strong');
  });

  it('positive variance row does NOT have red highlight classes', () => {
    render(<VarianceReport rows={[makeRow({ variance: 2, productName: 'Extra Vodka' })]} />);

    const row = getRowByProductName('Extra Vodka');
    expect(row.className).not.toContain('bg-destructive');
  });

  // -------------------------------------------------------------------------
  // Multiple rows with mixed variance
  // -------------------------------------------------------------------------

  it('S8-06: applies correct highlights to multiple rows independently', () => {
    const rows: PhysicalCountVarianceRow[] = [
      {
        productId: '1',
        productName: 'Short Item',
        expectedStock: 10,
        actualCount: 7,
        variance: -3,
      },
      {
        productId: '2',
        productName: 'Match Item',
        expectedStock: 10,
        actualCount: 10,
        variance: 0,
      },
      {
        productId: '3',
        productName: 'Extra Item',
        expectedStock: 10,
        actualCount: 14,
        variance: 4,
      },
    ];

    render(<VarianceReport rows={rows} />);

    const shortRow = getRowByProductName('Short Item');
    const matchRow = getRowByProductName('Match Item');
    const extraRow = getRowByProductName('Extra Item');

    expect(shortRow.className).toContain('bg-destructive/10');
    expect(matchRow.className).not.toContain('bg-destructive');
    expect(matchRow.className).not.toContain('bg-brand-soft');
    expect(extraRow.className).toContain('bg-brand-soft');
  });

  // -------------------------------------------------------------------------
  // Table structure
  // -------------------------------------------------------------------------

  it('renders a table with one row per entry', () => {
    const rows: PhysicalCountVarianceRow[] = [
      makeRow({ variance: -2, productName: 'A' }),
      makeRow({ variance: 0, productName: 'B' }),
      makeRow({ variance: 1, productName: 'C' }),
    ];

    render(<VarianceReport rows={rows} />);
    const table = screen.getByRole('table');
    const bodyRows = within(table).getAllByRole('row');
    // header row + 3 data rows = 4
    expect(bodyRows).toHaveLength(4);
  });
});
