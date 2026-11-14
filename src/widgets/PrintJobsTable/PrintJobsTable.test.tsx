import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PrintJobEntity from '@entities/print-job';
import type { PrintJob, PrintJobDetail } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';

import { PrintJobsTable } from './PrintJobsTable';

const mockUsePrintJobs = vi.fn();
const mockUsePrintJob = vi.fn();

vi.mock('@entities/print-job', async importOriginal => {
  const actual = await importOriginal<typeof PrintJobEntity>();
  return {
    ...actual,
    usePrintJobs: () => mockUsePrintJobs(),
    usePrintJob: () => mockUsePrintJob(),
  };
});

const JOB_A: PrintJob = {
  jobId: 'job-1111-1111-1111-111111111111',
  status: 'os_reported_printed',
  origin: 'reprint',
  printerName: 'Front Counter',
  attempts: 1,
  createdAt: new Date('2026-07-01T12:00:00Z'),
  updatedAt: new Date('2026-07-01T12:00:05Z'),
};

const JOB_B: PrintJob = {
  jobId: 'job-2222-2222-2222-222222222222',
  status: 'failed',
  origin: 'receipt',
  printerName: 'Back Office',
  attempts: 3,
  createdAt: new Date('2026-07-01T18:00:00Z'),
  updatedAt: new Date('2026-07-01T18:00:05Z'),
};

function renderTable() {
  return renderWithProviders(
    <MemoryRouter>
      <PrintJobsTable />
    </MemoryRouter>
  );
}

const JOB_A_DETAIL: PrintJobDetail = {
  ...JOB_A,
  winSpoolJobId: null,
  lastError: null,
  events: [],
};

describe('PrintJobsTable', () => {
  beforeEach(() => {
    mockUsePrintJob.mockReturnValue({ data: JOB_A_DETAIL, status: 'success' });
  });

  it('renders "No print jobs yet" when zero rows and no filters applied', () => {
    mockUsePrintJobs.mockReturnValue({
      data: { pages: [[]] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      status: 'success',
    });

    renderTable();

    expect(screen.getByText('No print jobs yet')).toBeInTheDocument();
  });

  it('renders "No print jobs match these filters" when a filter is applied with zero rows', async () => {
    const user = userEvent.setup();
    mockUsePrintJobs.mockReturnValue({
      data: { pages: [[]] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      status: 'success',
    });

    renderTable();

    await user.type(screen.getByPlaceholderText(/printer name/i), 'X');
    await user.click(screen.getByRole('button', { name: /apply filters/i }));

    expect(await screen.findByText('No print jobs match these filters')).toBeInTheDocument();
  });

  it('renders the load-error empty state when usePrintJobs status is error', () => {
    mockUsePrintJobs.mockReturnValue({
      data: undefined,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      status: 'error',
    });

    renderTable();

    expect(screen.getByText("Couldn't load print jobs")).toBeInTheDocument();
  });

  it('renders skeleton rows (not the empty state) while pending', () => {
    mockUsePrintJobs.mockReturnValue({
      data: undefined,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      status: 'pending',
    });

    renderTable();

    expect(screen.queryByText('No print jobs yet')).not.toBeInTheDocument();
  });

  it('clicking a row (or its sr-only trigger) opens the detail Sheet; truncated cell vs full aria-label', async () => {
    const user = userEvent.setup();
    mockUsePrintJobs.mockReturnValue({
      data: { pages: [[JOB_A, JOB_B]] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      status: 'success',
    });

    renderTable();

    const trigger = screen.getByRole('button', {
      name: new RegExp(`View print job ${JOB_A.jobId} from .*`, 'i'),
    });
    expect(trigger).toBeInTheDocument();

    // Truncated visual cell shows only the first 8 chars, not the full ID.
    expect(screen.queryByText(JOB_A.jobId)).not.toBeInTheDocument();

    await user.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});
