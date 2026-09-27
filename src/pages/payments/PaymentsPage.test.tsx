/**
 * Unit tests for PaymentsPage
 *
 * Tests: page title rendered, PaymentPane rendered. Navigation back to /home is
 * owned by the app shell's sidebar, so the page itself renders no back link.
 */

import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@shared/lib/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@widgets/PaymentPane', () => ({
  PaymentPane: () => <div data-testid="payment-pane">PaymentPane stub</div>,
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
});
