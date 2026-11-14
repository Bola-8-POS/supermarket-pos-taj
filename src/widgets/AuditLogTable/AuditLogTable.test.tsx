import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type * as AuditLogEntity from '@entities/audit-log';
import type * as StaffEntity from '@entities/staff';
import type { AuditLog, Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';

import { AuditLogTable } from './AuditLogTable';

const mockUseAuditLogs = vi.fn();
const mockUseStaffList = vi.fn();

vi.mock('@entities/audit-log', async importOriginal => {
  const actual = await importOriginal<typeof AuditLogEntity>();
  return {
    ...actual,
    useAuditLogs: () => mockUseAuditLogs(),
  };
});

vi.mock('@entities/staff', async importOriginal => {
  const actual = await importOriginal<typeof StaffEntity>();
  return {
    ...actual,
    useStaffList: () => mockUseStaffList(),
  };
});

const STAFF: Staff = {
  id: 'staff-1111-1111-1111-111111111111',
  name: 'Ana García',
  role: 'manager',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const ROW_A: AuditLog = {
  id: 'aaa11111-aaaa-1111-aaaa-111111111111',
  actorId: STAFF.id,
  action: 'payment.process',
  entityType: 'payment',
  entityId: 'pay-1111-1111-1111-111111111111',
  before: null,
  after: { amount: 100 },
  terminalId: null,
  source: 'rpc',
  createdAt: new Date('2026-07-01T12:00:00Z'),
};

const ROW_B: AuditLog = {
  id: 'bbb22222-bbbb-2222-bbbb-222222222222',
  actorId: null,
  action: 'caja.close',
  entityType: 'caja_session',
  entityId: null,
  before: { open: true },
  after: { open: false },
  terminalId: null,
  source: 'rpc',
  createdAt: new Date('2026-07-01T18:00:00Z'),
};

describe('AuditLogTable', () => {
  it('renders the action cell as plain text and an accessible diff button; clicking opens the sheet', async () => {
    const user = userEvent.setup();
    mockUseStaffList.mockReturnValue({ data: [STAFF] });
    mockUseAuditLogs.mockReturnValue({
      data: { pages: [[ROW_A, ROW_B]] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      status: 'success',
    });

    renderWithProviders(
      <MemoryRouter>
        <AuditLogTable />
      </MemoryRouter>
    );

    // The cell's accessible name is "name from content", which also picks up
    // the sr-only diff button's aria-label text; match on the leading raw
    // action string (mirrors e2e/38-audit-logs.spec.ts's substring-based
    // Playwright getByRole('cell', { name: 'payment.process' }) query).
    expect(screen.getByRole('cell', { name: /^payment\.process/ })).toBeInTheDocument();

    const diffButton = screen.getByRole('button', { name: /view diff for payment\.process on .*/i });
    expect(diffButton).toBeInTheDocument();

    // ROW_A's new entityId column renders a real navigation link (payment
    // entityType is in EntityIdCell's LINKABLE_TYPES allowlist).
    const viewPaymentLink = screen.getByRole('link', { name: /view payment/i });
    expect(viewPaymentLink).toBeInTheDocument();
    expect(viewPaymentLink).toHaveAttribute('href', `/payments?id=${ROW_A.entityId}`);

    await user.click(diffButton);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('shows "No matches" when zero rows are returned with a filter applied', async () => {
    const user = userEvent.setup();
    mockUseStaffList.mockReturnValue({ data: [STAFF] });
    mockUseAuditLogs.mockReturnValue({
      data: { pages: [[]] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      status: 'success',
    });

    renderWithProviders(
      <MemoryRouter>
        <AuditLogTable />
      </MemoryRouter>
    );

    // Before any filter is applied: zero-rows-ever empty copy.
    expect(screen.getByText('No audit activity yet')).toBeInTheDocument();

    // Stage a search term and apply — flips to the "filtered, no matches" copy.
    await user.type(
      screen.getByPlaceholderText('Search by entity ID or action…'),
      'budweiser',
    );
    await user.click(screen.getByRole('button', { name: /apply filters/i }));

    expect(await screen.findByText('No matches')).toBeInTheDocument();
  });
});
