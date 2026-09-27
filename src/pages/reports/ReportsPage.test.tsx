/**
 * RTL tests for ReportsPage (src/pages/reports/index.tsx).
 *
 * Child panels are mocked to avoid deep dependency chains.
 * Tests focus on tab switching behaviour and date-input defaults.
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';

// ---------------------------------------------------------------------------
// Mock heavy child widgets — zero business logic needed here
// ---------------------------------------------------------------------------

vi.mock('@widgets/CajaReportPanel', () => ({
  CajaReportPanel: () => <div data-testid="caja-report-panel">CajaReportPanel</div>,
}));

vi.mock('@widgets/ProductSalesPanel', () => ({
  ProductSalesPanel: () => <div data-testid="product-sales-panel">ProductSalesPanel</div>,
}));

vi.mock('@widgets/HourlyBreakdownPanel', () => ({
  HourlyBreakdownPanel: () => <div data-testid="hourly-breakdown-panel">HourlyBreakdownPanel</div>,
}));

// ---------------------------------------------------------------------------
// Lazy-import after mocks are registered
// ---------------------------------------------------------------------------

import ReportsPage from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

function renderPage() {
  const user = userEvent.setup();
  const result = renderWithProviders(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>
  );
  return { ...result, user };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('default tab is Session View — CajaReportPanel is visible', () => {
    renderPage();

    // Active tab panel renders its content immediately
    expect(screen.getByTestId('caja-report-panel')).toBeInTheDocument();

    // Session View tab is selected
    expect(screen.getByRole('tab', { name: /session view/i })).toHaveAttribute(
      'data-state',
      'active'
    );
  });

  it('clicking Product Sales tab shows ProductSalesPanel', async () => {
    const { user } = renderPage();

    await user.click(screen.getByRole('tab', { name: /product sales/i }));

    expect(screen.getByTestId('product-sales-panel')).toBeInTheDocument();
  });

  it('clicking Hourly Breakdown tab shows HourlyBreakdownPanel', async () => {
    const { user } = renderPage();

    await user.click(screen.getByRole('tab', { name: /hourly breakdown/i }));

    expect(screen.getByTestId('hourly-breakdown-panel')).toBeInTheDocument();
  });

  it('date range inputs default to today (YYYY-MM-DD) after navigating to Product Sales tab', async () => {
    const { user } = renderPage();

    // Navigate to Product Sales tab to mount the date inputs
    await user.click(screen.getByRole('tab', { name: /product sales/i }));

    const today = todayIso();

    // Both From and To inputs should show today
    const dateInputs = screen.getAllByDisplayValue(today);
    expect(dateInputs.length).toBeGreaterThanOrEqual(2);
  });
});
