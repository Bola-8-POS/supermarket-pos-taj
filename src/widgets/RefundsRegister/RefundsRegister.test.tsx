import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type * as QueriesReports from '@entities/tab/model/queries-reports';
import type { RefundRegisterRow } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { RefundsRegister } from './RefundsRegister';

const mockUseRefundsRegister = vi.fn();

vi.mock('@entities/tab/model/queries-reports', async importOriginal => {
  const actual = await importOriginal<typeof QueriesReports>();
  return {
    ...actual,
    useRefundsRegister: () => mockUseRefundsRegister(),
  };
});
vi.mock('@features/export-report', () => ({
  ExportButtons: () => <button>Export</button>,
}));

const dateRange = { from: new Date('2026-01-01'), to: new Date('2026-01-31') };

const ROW_A: RefundRegisterRow = {
  id: 'aaa-111-aaa-111-aaa1',
  date: new Date('2026-01-10T12:00:00Z'),
  operatorName: 'Ana García',
  originalPaymentId: 'pay-aaa1-aaa1-aaa1-aaa111111111',
  amount: 150.0,
  reason: 'wrong_order',
  restockCount: 1,
  items: [],
};

const ROW_B: RefundRegisterRow = {
  id: 'bbb-222-bbb-222-bbb2',
  date: new Date('2026-01-15T14:30:00Z'),
  operatorName: 'Luis López',
  originalPaymentId: 'pay-bbb2-bbb2-bbb2-bbb222222222',
  amount: 75.5,
  reason: 'customer_complaint',
  restockCount: 0,
  items: [],
};

describe('RefundsRegister', () => {
  it('renders EmptyState with "No refunds" when rows is empty', () => {
    mockUseRefundsRegister.mockReturnValue({ isLoading: false, data: { ok: true, data: [] } });
    renderWithProviders(<RefundsRegister dateRange={dateRange} />);
    expect(screen.getByText('No refunds')).toBeInTheDocument();
  });

  it('renders totals row with sum of amounts', () => {
    mockUseRefundsRegister.mockReturnValue({
      isLoading: false,
      data: { ok: true, data: [ROW_A, ROW_B] },
    });
    renderWithProviders(<RefundsRegister dateRange={dateRange} />);
    // Total: 150.00 + 75.50 = 225.50
    expect(screen.getByText('$225.50')).toBeInTheDocument();
    // Totals row label
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('renders totals row with border-t-2 font-semibold class', () => {
    mockUseRefundsRegister.mockReturnValue({
      isLoading: false,
      data: { ok: true, data: [ROW_A] },
    });
    const { container } = renderWithProviders(<RefundsRegister dateRange={dateRange} />);
    const totalsRow = container.querySelector('tbody tr:last-child');
    expect(totalsRow?.className).toContain('border-t-2');
    expect(totalsRow?.className).toContain('font-semibold');
  });

  it('does not render "Manager" or "Approved by" column header', () => {
    mockUseRefundsRegister.mockReturnValue({
      isLoading: false,
      data: { ok: true, data: [ROW_A] },
    });
    renderWithProviders(<RefundsRegister dateRange={dateRange} />);
    expect(screen.queryByText(/Manager/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Approved/i)).not.toBeInTheDocument();
  });

  it('renders LoadingSpinner while isLoading', () => {
    mockUseRefundsRegister.mockReturnValue({ isLoading: true, data: undefined });
    renderWithProviders(<RefundsRegister dateRange={dateRange} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('paginates a large row set instead of rendering every row at once', async () => {
    const manyRows: RefundRegisterRow[] = Array.from({ length: 30 }, (_, i) => ({
      ...ROW_A,
      id: `row-${String(i)}`,
      operatorName: `Operator ${String(i)}`,
    }));
    mockUseRefundsRegister.mockReturnValue({ isLoading: false, data: { ok: true, data: manyRows } });
    renderWithProviders(<RefundsRegister dateRange={dateRange} />);

    // Page 1: first 25 rows visible, the 26th is not yet rendered.
    expect(screen.getByText('Operator 0')).toBeInTheDocument();
    expect(screen.getByText('Operator 24')).toBeInTheDocument();
    expect(screen.queryByText('Operator 25')).not.toBeInTheDocument();
    // Totals row always reflects every row, not just the current page.
    expect(screen.getByText('$4,500.00')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /next page/i }));

    expect(screen.queryByText('Operator 0')).not.toBeInTheDocument();
    expect(screen.getByText('Operator 25')).toBeInTheDocument();
    expect(screen.getByText('Operator 29')).toBeInTheDocument();
  });
});
