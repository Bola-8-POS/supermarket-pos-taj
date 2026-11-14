/**
 * Unit tests for PaymentsPage
 *
 * Tests: page title rendered, PaymentPane rendered. Navigation back to /home is
 * owned by the app shell's sidebar, so the page itself renders no back link.
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { useOfflineSaleStore } from '@entities/offline-sale';
import { makeSale } from '@entities/offline-sale/model/offline-sale.fixtures';
import { renderWithProviders } from '@shared/lib/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@widgets/PaymentPane', () => ({
  PaymentPane: () => <div data-testid="payment-pane">PaymentPane stub</div>,
}));

// The dialog has its own tests; here it is a marker that proves the button opens it.
vi.mock('@features/review-offline-sales', () => ({
  OfflineSalesDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="offline-sales-dialog" /> : null,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import PaymentsPage from './index';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function renderPage() {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/payments']}>
      <PaymentsPage />
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsPage', () => {
  it('renders the page title and no in-page back link', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /payments|pagos/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /home|inicio/i })).not.toBeInTheDocument();
  });

  it('renders PaymentPane', () => {
    renderPage();
    expect(screen.getByTestId('payment-pane')).toBeInTheDocument();
  });

  it('the payments page offers the offline sales history when records exist and hides it otherwise', async () => {
    useOfflineSaleStore.setState({ records: [] });
    const { unmount } = renderPage();
    expect(screen.queryByTestId('offline-sales-open-history')).not.toBeInTheDocument();
    unmount();

    // a confirmed record is kept for reprint, so it counts even though nothing is pending
    useOfflineSaleStore.setState({
      records: [makeSale({ status: 'confirmed', tabId: '9f8e7d6c-1111-4222-8333-444444444444' })],
    });
    renderPage();
    const open = screen.getByTestId('offline-sales-open-history');
    expect(open).toHaveAccessibleName(/offline sales/i);
    expect(screen.queryByTestId('offline-sales-dialog')).not.toBeInTheDocument();
    await userEvent.click(open);
    expect(screen.getByTestId('offline-sales-dialog')).toBeInTheDocument();
    useOfflineSaleStore.setState({ records: [] });
  });
});
