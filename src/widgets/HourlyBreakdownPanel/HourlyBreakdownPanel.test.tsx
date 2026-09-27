/**
 * RTL component tests for HourlyBreakdownPanel.
 * Mocks useHourlyBreakdown and the pure helpers to isolate rendering logic.
 */

import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as QueriesReports from '@entities/tab/model/queries-reports';
import { fillMissingHours, type HourlyRow } from '@entities/tab/model/queries-reports';
import { renderWithProviders } from '@shared/lib/test-utils';
import { HourlyBreakdownPanel } from './HourlyBreakdownPanel';

// ---------------------------------------------------------------------------
// Mock the queries-reports module
// ---------------------------------------------------------------------------

const mockUseHourlyBreakdown = vi.fn();
// Keep real implementations for pure helpers used inside the component
const realFillMissingHours = fillMissingHours;

vi.mock('@entities/tab/model/queries-reports', async importOriginal => {
  const actual = await importOriginal<typeof QueriesReports>();
  return {
    ...actual,
    useHourlyBreakdown: () => mockUseHourlyBreakdown(),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Sparse input: only hours 8 and 21 have data. */
const sparseRows: HourlyRow[] = [
  { hour: 8, orderCount: 3, revenue: 60, dayOfWeek: 1, isBusiest: false },
  { hour: 21, orderCount: 10, revenue: 400, dayOfWeek: 1, isBusiest: false },
];

/** Full 24-row data produced by fillMissingHours on the sparse input. */
const filledRows = realFillMissingHours(sparseRows);

const dateRange = { from: new Date('2026-04-20T00:00:00'), to: new Date('2026-04-20T23:59:59') };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HourlyBreakdownPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders 24 table rows when all-hours data is provided', () => {
    mockUseHourlyBreakdown.mockReturnValue({
      data: { ok: true, data: filledRows },
      isLoading: false,
    });

    renderWithProviders(<HourlyBreakdownPanel dateRange={dateRange} />);

    const tbody = document.querySelector('tbody');
    expect(tbody).not.toBeNull();
    const rows = within(tbody as HTMLElement).getAllByRole('row');
    expect(rows).toHaveLength(24);
  });

  it('shows Peak callout referencing hour 21 (highest revenue)', () => {
    mockUseHourlyBreakdown.mockReturnValue({
      data: { ok: true, data: filledRows },
      isLoading: false,
    });

    renderWithProviders(<HourlyBreakdownPanel dateRange={dateRange} />);

    // formatHour(21) → "9:00 PM"
    const calloutArea = screen.getByText(/Peak:/i).closest('div');
    expect(calloutArea?.textContent).toMatch(/9:00 PM/);
  });

  it('shows Slowest callout referencing hour 8 (lowest non-zero revenue)', () => {
    mockUseHourlyBreakdown.mockReturnValue({
      data: { ok: true, data: filledRows },
      isLoading: false,
    });

    renderWithProviders(<HourlyBreakdownPanel dateRange={dateRange} />);

    // formatHour(8) → "8:00 AM"
    const calloutArea = screen.getByText(/Slowest:/i).closest('div');
    expect(calloutArea?.textContent).toMatch(/8:00 AM/);
  });

  it('renders empty state when all rows have zero revenue', () => {
    const allZero = realFillMissingHours([]);
    mockUseHourlyBreakdown.mockReturnValue({
      data: { ok: true, data: allZero },
      isLoading: false,
    });

    renderWithProviders(<HourlyBreakdownPanel dateRange={dateRange} />);

    expect(screen.getByText('No hourly data')).toBeInTheDocument();
  });

  it('renders loading spinner while query is in flight', () => {
    mockUseHourlyBreakdown.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    renderWithProviders(<HourlyBreakdownPanel dateRange={dateRange} />);

    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // New tests — Task 3
  // -------------------------------------------------------------------------

  it('12-hour time format: hour 0 displays as "12:00 AM" and hour 13 displays as "1:00 PM"', () => {
    // Build filled rows that include hour 0 (already zero by default) and hour 13
    const rows = realFillMissingHours([
      { hour: 13, orderCount: 4, revenue: 80, dayOfWeek: 1, isBusiest: false },
      { hour: 21, orderCount: 10, revenue: 400, dayOfWeek: 1, isBusiest: false },
    ]);

    mockUseHourlyBreakdown.mockReturnValue({
      data: { ok: true, data: rows },
      isLoading: false,
    });

    renderWithProviders(<HourlyBreakdownPanel dateRange={dateRange} />);

    // Hour 0 formatted as 12:00 AM
    expect(screen.getByText('12:00 AM')).toBeInTheDocument();
    // Hour 13 formatted as 1:00 PM
    expect(screen.getByText('1:00 PM')).toBeInTheDocument();
  });

  it('does NOT render "Slowest" callout when all revenue rows are zero', () => {
    const allZeroRows = realFillMissingHours([]);

    mockUseHourlyBreakdown.mockReturnValue({
      data: { ok: true, data: allZeroRows },
      isLoading: false,
    });

    renderWithProviders(<HourlyBreakdownPanel dateRange={dateRange} />);

    // Component renders EmptyState when all rows are zero — no slowest text
    expect(screen.queryByText(/Slowest/i)).not.toBeInTheDocument();
  });

  it('single non-zero hour: Peak callout visible; table row gets only peak (pos-highlight) highlight, not slowest (pos-warning)', () => {
    // Only hour 10 has revenue.
    // findPeakHour and findSlowestHour both return the same row.
    // The callout area shows both Peak and Slowest labels.
    // The table row guard: isSlowest = slowestHour !== null && row.hour === slowestHour.hour && !isPeak
    // → isPeak is true for hour 10, so isSlowest is false → no amber class on that row.
    const rows = realFillMissingHours([
      { hour: 10, orderCount: 2, revenue: 120, dayOfWeek: 1, isBusiest: false },
    ]);

    mockUseHourlyBreakdown.mockReturnValue({
      data: { ok: true, data: rows },
      isLoading: false,
    });

    renderWithProviders(<HourlyBreakdownPanel dateRange={dateRange} />);

    // Peak callout must appear
    expect(screen.getByText(/Peak:/i)).toBeInTheDocument();

    // The table row for hour 10 must have the peak (pos-highlight) class, NOT the slowest (pos-warning) class.
    const tbody = document.querySelector('tbody') as HTMLElement;
    const allRows = within(tbody).getAllByRole('row');
    const row10 = allRows.find(r => r.textContent?.includes('10:00 AM'));
    expect(row10).toBeDefined();
    expect(row10!.className).toMatch(/brand/);
    expect(row10!.className).not.toMatch(/warning/);
  });
});
