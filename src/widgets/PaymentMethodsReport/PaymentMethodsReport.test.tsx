import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type * as QueriesReports from '@entities/tab/model/queries-reports';
import type { PaymentMethodRow } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { PaymentMethodsReport } from './PaymentMethodsReport';

const mockUsePaymentMethodsReport = vi.fn();

vi.mock('@entities/tab/model/queries-reports', async importOriginal => {
  const actual = await importOriginal<typeof QueriesReports>();
  return {
    ...actual,
    usePaymentMethodsReport: () => mockUsePaymentMethodsReport(),
  };
});
vi.mock('@features/export-report', () => ({
  ExportButtons: () => <button>Export</button>,
}));

const dateRange = { from: new Date('2026-01-01'), to: new Date('2026-01-31') };

/** One session-grain row + the day-level rollup row it feeds. */
function sessionRow(cajaSessionId: string): PaymentMethodRow {
  return { cajaSessionId, method: 'cash', legCount: 1, grossAmount: 100, isRollup: false };
}
const rollupRow: PaymentMethodRow = {
  cajaSessionId: null,
  method: 'cash',
  legCount: 30,
  grossAmount: 3000,
  isRollup: true,
};

describe('PaymentMethodsReport', () => {
  it('renders EmptyState when rows is empty', () => {
    mockUsePaymentMethodsReport.mockReturnValue({ isLoading: false, data: { ok: true, data: [] } });
    renderWithProviders(<PaymentMethodsReport dateRange={dateRange} />);
    expect(screen.getByText('No payments recorded')).toBeInTheDocument();
  });

  it('paginates session-grain rows while always keeping the rollup row visible', async () => {
    // Zero-padded so the component's localeCompare sort on cajaSessionId
    // lands in the same order as the index, matching real UUID sort order.
    const sessionRows = Array.from({ length: 30 }, (_, i) =>
      sessionRow(`session-${String(i).padStart(2, '0')}`)
    );
    mockUsePaymentMethodsReport.mockReturnValue({
      isLoading: false,
      data: { ok: true, data: [...sessionRows, rollupRow] },
    });
    renderWithProviders(<PaymentMethodsReport dateRange={dateRange} />);

    // Page 1: first 25 sessions + the rollup row, 26th session not yet rendered.
    expect(screen.getByText('session-00')).toBeInTheDocument();
    expect(screen.getByText('session-24')).toBeInTheDocument();
    expect(screen.queryByText('session-25')).not.toBeInTheDocument();
    expect(screen.getByText('Day total')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /next page/i }));

    expect(screen.queryByText('session-00')).not.toBeInTheDocument();
    expect(screen.getByText('session-25')).toBeInTheDocument();
    expect(screen.getByText('session-29')).toBeInTheDocument();
    // Rollup row is pinned to the bottom of every page, not just page 1.
    expect(screen.getByText('Day total')).toBeInTheDocument();
  });
});
