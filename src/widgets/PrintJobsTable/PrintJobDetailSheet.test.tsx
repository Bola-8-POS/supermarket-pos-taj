import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PrintJobDetail } from '@entities/print-job';
import { renderWithProviders } from '@shared/lib/test-utils';

import { PrintJobDetailSheet } from './PrintJobDetailSheet';

const DETAIL: PrintJobDetail = {
  jobId: 'job-1111-1111-1111-111111111111',
  status: 'os_reported_printed',
  origin: 'reprint',
  printerName: 'Front Counter',
  attempts: 2,
  createdAt: new Date('2026-07-01T12:00:00Z'),
  updatedAt: new Date('2026-07-01T12:00:05Z'),
  winSpoolJobId: 42,
  lastError: null,
  events: [
    { ts: new Date('2026-07-01T12:00:00Z'), category: 'accepted', detail: null },
    { ts: new Date('2026-07-01T12:00:02Z'), category: 'submitted_to_os', detail: null },
    {
      ts: new Date('2026-07-01T12:00:04Z'),
      category: 'os_reported_printed',
      detail: 'Confirmed by spooler',
    },
  ],
};

describe('PrintJobDetailSheet', () => {
  it('renders 3 timeline rows in ascending timestamp order, showing category and error text', () => {
    renderWithProviders(
      <PrintJobDetailSheet row={DETAIL} open onOpenChange={vi.fn()} />
    );

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('accepted');
    expect(rows[1]).toHaveTextContent('submitted_to_os');
    expect(rows[2]).toHaveTextContent('os_reported_printed');
    expect(rows[2]).toHaveTextContent('Confirmed by spooler');
  });

  it('renders without throwing when winSpoolJobId is null and there are zero events', () => {
    const detail: PrintJobDetail = { ...DETAIL, winSpoolJobId: null, events: [] };

    expect(() => {
      renderWithProviders(<PrintJobDetailSheet row={detail} open onOpenChange={vi.fn()} />);
    }).not.toThrow();

    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('does not import or render JsonDiffViewer', () => {
    renderWithProviders(<PrintJobDetailSheet row={DETAIL} open onOpenChange={vi.fn()} />);
    expect(screen.queryByTestId('json-diff-viewer')).not.toBeInTheDocument();
  });
});
