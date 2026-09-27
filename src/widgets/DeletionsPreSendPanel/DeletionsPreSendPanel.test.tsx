/**
 * RTL component tests for DeletionsPreSendPanel.
 * Mocks useDeletionsPreReport to isolate rendering logic — confirms the
 * orderId column is wired to EntityIdCell with entityType="order_item"
 * (copy-only, not in D-02's LINKABLE_TYPES allowlist). EntityIdCell's
 * copy-only rendering branch itself is exhaustively unit-tested generically
 * in src/shared/ui/EntityIdCell.test.tsx (plan 10-05) — this test only
 * confirms the correct entityType prop is wired through here.
 */
import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type * as QueriesReports from '@entities/tab/model/queries-reports';
import type { DeletionsPreRow } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';

import { DeletionsPreSendPanel } from './DeletionsPreSendPanel';

const mockUseDeletionsPreReport = vi.fn();

vi.mock('@entities/tab/model/queries-reports', async importOriginal => {
  const actual = await importOriginal<typeof QueriesReports>();
  return {
    ...actual,
    useDeletionsPreReport: () => mockUseDeletionsPreReport(),
  };
});

const sampleRow: DeletionsPreRow = {
  orderId: 'ord-1111-1111-1111-111111111111',
  itemName: 'Basmati Rice 5kg',
  removedAt: new Date('2026-08-18T12:00:00Z'),
  staffName: 'Ana García',
  reason: 'Wrong item scanned',
};

const dateRange = { from: new Date('2026-08-18T00:00:00'), to: new Date('2026-08-18T23:59:59') };

describe('DeletionsPreSendPanel', () => {
  it('renders the orderId as copy-only text (no navigation link) since order_item is not linkable', () => {
    mockUseDeletionsPreReport.mockReturnValue({
      data: { ok: true, data: [sampleRow] },
      isLoading: false,
    });

    renderWithProviders(
      <MemoryRouter>
        <DeletionsPreSendPanel dateRange={dateRange} />
      </MemoryRouter>
    );

    // No navigation link for the order_item entityType — EntityIdCell's
    // LINKABLE_TYPES allowlist is payment/tab/staff only.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    // A copy button IS present for the row's orderId (the only interactive
    // control this cell renders when copy-only).
    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByText(sampleRow.orderId.slice(0, 8))).toBeInTheDocument();
  });
});
