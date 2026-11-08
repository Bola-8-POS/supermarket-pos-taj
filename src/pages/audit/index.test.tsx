/**
 * RTL tests for AuditPage (src/pages/audit/index.tsx).
 *
 * Child widgets are mocked to avoid deep dependency chains. Tests focus on
 * tab switching behaviour, mirroring ReportsPage.test.tsx's pattern.
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';

// ---------------------------------------------------------------------------
// Mock heavy child widgets — zero business logic needed here
// ---------------------------------------------------------------------------

vi.mock('@widgets/AuditLogTable', () => ({
  AuditLogTable: () => <div data-testid="audit-log-table">AuditLogTable</div>,
}));

vi.mock('@widgets/PrintJobsTable', () => ({
  PrintJobsTable: () => <div data-testid="print-jobs-table">PrintJobsTable</div>,
}));

// ---------------------------------------------------------------------------
// Lazy-import after mocks are registered
// ---------------------------------------------------------------------------

import AuditPage from './index';

function renderPage() {
  const user = userEvent.setup();
  const result = renderWithProviders(
    <MemoryRouter>
      <AuditPage />
    </MemoryRouter>
  );
  return { ...result, user };
}

describe('AuditPage', () => {
  it('default tab is Audit Log — AuditLogTable is visible and its tab trigger is active', () => {
    renderPage();

    expect(screen.getByTestId('audit-log-table')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /audit log/i })).toHaveAttribute(
      'data-state',
      'active'
    );
  });

  it('clicking the Print Jobs tab shows PrintJobsTable instead of AuditLogTable', async () => {
    const { user } = renderPage();

    await user.click(screen.getByRole('tab', { name: /print jobs/i }));

    expect(screen.getByTestId('print-jobs-table')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-log-table')).not.toBeInTheDocument();
  });
});
