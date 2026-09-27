import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import type * as PosPrinter from '@shared/lib/pos-printer';
import { printReceipt } from '@shared/lib/pos-printer';
import { err } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';
import { ReceiptPreview } from './ReceiptPreview';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@shared/lib/pos-printer', async importOriginal => {
  const actual = await importOriginal<typeof PosPrinter>();
  return {
    ...actual,
    printReceipt: vi.fn().mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } }),
  };
});

vi.mock('@entities/settings', () => ({
  useReceiptSettings: () => ({ data: undefined }),
}));

vi.mock('./EmailReceiptDialog', () => ({
  EmailReceiptDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="email-dialog-open">email</div> : null,
}));

const receipt: ReceiptData = {
  receiptNumber: 'R1',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  customerName: 'Guest',
  cashierName: 'Staff',
  storeName: 'Bar',
  barAddress: '',
  items: [{ name: 'Beer', quantity: 1, unitPrice: 5, lineTotal: 5 }],
  subtotal: 5,
  total: 5,
  paymentMethod: 'cash',
  processedAt: new Date('2026-04-17T12:00:00.000Z'),
  squareReceiptUrl: null,
  tenderedAmount: 10,
  changeAmount: 5,
};

describe('ReceiptPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(printReceipt).mockResolvedValue({ ok: true, data: { jobId: 'mock-job' } });
  });

  it('renders thermal receipt text', () => {
    const onDone = vi.fn();
    renderWithProviders(<ReceiptPreview receipt={receipt} onDone={onDone} />);
    expect(screen.getByText(/Beer/)).toBeInTheDocument();
    expect(screen.getByText(/Subtotal/)).toBeInTheDocument();
  });

  it('shows Printing while printReceipt pending then idle', async () => {
    const user = userEvent.setup();
    let resolvePrint: (v: { ok: true; data: { jobId: string } }) => void = () => {};
    const printPromise = new Promise<{ ok: true; data: { jobId: string } }>(res => {
      resolvePrint = res;
    });
    vi.mocked(printReceipt).mockReturnValue(printPromise);

    renderWithProviders(<ReceiptPreview receipt={receipt} onDone={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Print receipt' }));
    expect(screen.getByRole('button', { name: 'Printing…' })).toBeDisabled();

    resolvePrint({ ok: true, data: { jobId: 'mock-job' } });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Print receipt' })).toBeInTheDocument();
    });
  });

  it('shows the translated rejected copy on print failure (not a silent discard); printBusy still resets to false', async () => {
    const user = userEvent.setup();
    vi.mocked(printReceipt).mockResolvedValueOnce(err({ code: 'PRINT_JOB_REJECTED', message: 'z' }));

    renderWithProviders(<ReceiptPreview receipt={receipt} onDone={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Print receipt' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Printer rejected this job. Check the printer name in Settings and try again.'
      );
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Print receipt' })).toBeInTheDocument();
    });
  });

  it('shows no toast when the print succeeds (no-success-toast rule)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceiptPreview receipt={receipt} onDone={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Print receipt' }));

    await waitFor(() => {
      expect(printReceipt).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('opens email dialog when Email receipt clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceiptPreview receipt={receipt} onDone={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Email receipt' }));
    expect(screen.getByTestId('email-dialog-open')).toBeInTheDocument();
  });

  it('calls onDone from Done button', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    renderWithProviders(<ReceiptPreview receipt={receipt} onDone={onDone} />);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalled();
  });
});
