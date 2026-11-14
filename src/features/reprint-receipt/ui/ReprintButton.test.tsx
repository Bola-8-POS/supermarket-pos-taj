/**
 * Unit tests for ReprintButton (Plan 19-04, D-11) — closes the second,
 * subtler silent-discard: handleClick previously called `printReceipt` but
 * never inspected its returned Result, so a broker rejection was never
 * surfaced to the cashier. Covers: the returned Result is now branched on
 * (failure -> translated printJobErrorCopyKey toast; success -> no toast,
 * matching the no-success-toast rule), while a genuine data-fetch failure
 * still falls through to the existing generic reprintDataFailed toast.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Payment } from '@entities/payment';
import type { PrintJobDetail } from '@entities/print-job';
import type * as PosPrinter from '@shared/lib/pos-printer';
import { printReceipt } from '@shared/lib/pos-printer';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';

import { ReprintButton } from './ReprintButton';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockFetchReceiptDataForPayment = vi.fn();

vi.mock('@entities/payment', () => ({
  fetchReceiptDataForPayment: (tabId: string) => mockFetchReceiptDataForPayment(tabId),
  paymentReceiptKeys: { byTab: (tabId: string) => ['payment', 'receipt-data', tabId] },
}));

vi.mock('@entities/settings', () => ({
  useReceiptSettings: () => ({ data: undefined }),
}));

// Decoupled from the real jobId-gating flow (usePrintJob's `enabled` option)
// so Plan 19-06's badge/confirm tests can drive the badge directly — default
// undefined (no badge) matches Plan 19-04's pre-existing tests below, which
// don't exercise the badge at all.
const mockUsePrintJob = vi.fn<() => { data: PrintJobDetail | undefined }>(() => ({ data: undefined }));
vi.mock('@entities/print-job', () => ({
  usePrintJob: () => mockUsePrintJob(),
}));

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return {
    ...actual,
    printReceipt: vi.fn(),
    isTauri: () => true,
  };
});

const payment: Payment = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tabId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  amount: 20,
  method: 'cash',
  squarePaymentId: null,
  squareReceiptUrl: null,
  tenderedAmount: 20,
  referenceNumber: null,
  idempotencyKey: null,
  processedAt: new Date('2026-04-17T12:00:00.000Z'),
  processedBy: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  status: 'completed',
};

const receiptData = {
  receiptNumber: 'R1',
  tabId: payment.tabId,
  customerName: 'Guest',
  cashierName: 'Staff',
  storeName: 'Bar',
  barAddress: '',
  items: [],
  subtotal: 20,
  total: 20,
  paymentMethod: 'cash' as const,
  processedAt: new Date('2026-04-17T12:00:00.000Z'),
  squareReceiptUrl: null,
  tenderedAmount: 20,
  changeAmount: 0,
};

describe('ReprintButton — print Result handling (no silent discard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchReceiptDataForPayment.mockResolvedValue(receiptData);
    vi.mocked(printReceipt).mockResolvedValue(ok({ jobId: 'mock-job' }));
    mockUsePrintJob.mockReturnValue({ data: undefined });
  });

  it('shows the translated rejected copy when printReceipt returns a failed Result (previously never inspected)', async () => {
    const user = userEvent.setup();
    vi.mocked(printReceipt).mockResolvedValue(err({ code: 'PRINT_JOB_REJECTED', message: 'z' }));
    renderWithProviders(<ReprintButton payment={payment} />);

    await user.click(screen.getByRole('button', { name: 'Reprint' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Printer rejected this job. Check the printer name in Settings and try again.'
      );
    });
  });

  it('shows no toast when printReceipt succeeds (no-success-toast rule)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReprintButton payment={payment} />);

    await user.click(screen.getByRole('button', { name: 'Reprint' }));

    await waitFor(() => {
      expect(printReceipt).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('still shows the generic reprintDataFailed toast on a data-fetch failure (distinct from a print failure)', async () => {
    const user = userEvent.setup();
    mockFetchReceiptDataForPayment.mockRejectedValue(new Error('not found'));
    renderWithProviders(<ReprintButton payment={payment} />);

    await user.click(screen.getByRole('button', { name: 'Reprint' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't load this sale's receipt — try again.");
    });
    expect(printReceipt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Plan 19-06: PrintJobStatusBadge + "Did this print?" confirm wiring
// ---------------------------------------------------------------------------

const unknownJob: PrintJobDetail = {
  jobId: 'mock-job',
  status: 'unknown',
  origin: 'receipt',
  printerName: 'RECEIPT_PRINTER',
  attempts: 1,
  createdAt: new Date('2026-04-17T12:00:00.000Z'),
  updatedAt: new Date('2026-04-17T12:00:01.000Z'),
  winSpoolJobId: null,
  lastError: 'spooler no longer reports this job id',
  events: [],
};

describe('ReprintButton — PrintJobStatusBadge + confirm wiring (Plan 19-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchReceiptDataForPayment.mockResolvedValue(receiptData);
    vi.mocked(printReceipt).mockResolvedValue(ok({ jobId: 'mock-job' }));
  });

  it('renders no badge before any print attempt (no job tracked yet)', () => {
    mockUsePrintJob.mockReturnValue({ data: undefined });
    renderWithProviders(<ReprintButton payment={payment} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('Test 9: clicking the unknown badge opens "Did this print?"; "Yes, it printed" dismisses without reprinting', async () => {
    const user = userEvent.setup();
    mockUsePrintJob.mockReturnValue({ data: unknownJob });
    renderWithProviders(<ReprintButton payment={payment} />);

    await user.click(screen.getByRole('status'));
    expect(screen.getByText('Did this print?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Yes, it printed' }));
    await waitFor(() => {
      expect(screen.queryByText('Did this print?')).not.toBeInTheDocument();
    });
    expect(printReceipt).not.toHaveBeenCalled();
  });

  it('Test 9: "No, print again" triggers a fresh printReceipt() call and then dismisses', async () => {
    const user = userEvent.setup();
    mockUsePrintJob.mockReturnValue({ data: unknownJob });
    renderWithProviders(<ReprintButton payment={payment} />);

    await user.click(screen.getByRole('status'));
    await user.click(screen.getByRole('button', { name: 'No, print again' }));

    await waitFor(() => {
      expect(printReceipt).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByText('Did this print?')).not.toBeInTheDocument();
    });
  });

  it('Test 10: dismissing the unknown badge (its own "x") hides it locally without calling printReceipt', async () => {
    const user = userEvent.setup();
    mockUsePrintJob.mockReturnValue({ data: unknownJob });
    renderWithProviders(<ReprintButton payment={payment} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(printReceipt).not.toHaveBeenCalled();
  });
});
