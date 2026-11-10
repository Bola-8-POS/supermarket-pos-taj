import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiptSettingsSchema } from '@shared/lib/domain';
import type { ReceiptData } from '@shared/lib/edge-function-contracts';
import { sendReceiptByEmail } from '@shared/lib/email-receipt';
import { renderWithProviders } from '@shared/lib/test-utils';
import { EmailReceiptDialog } from './EmailReceiptDialog';

vi.mock('@shared/lib/email-receipt', () => ({
  sendReceiptByEmail: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const receipt: ReceiptData = {
  receiptNumber: 'R1',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  customerName: 'Guest',
  cashierName: 'Staff',
  storeName: 'Bar',
  barAddress: '',
  items: [],
  subtotal: 1,
  total: 1,
  paymentMethod: 'cash',
  processedAt: new Date(),
  squareReceiptUrl: null,
  tenderedAmount: 5,
  changeAmount: 4,
};

describe('EmailReceiptDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows validation error for invalid email', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <EmailReceiptDialog
        receipt={receipt}
        settings={ReceiptSettingsSchema.parse({})}
        open
        onOpenChange={onOpenChange}
      />
    );

    await user.type(screen.getByLabelText('Email'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Send Receipt' }));

    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(vi.mocked(sendReceiptByEmail)).not.toHaveBeenCalled();
  });

  it('sends email, toasts success, and closes on success', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    vi.mocked(sendReceiptByEmail).mockResolvedValue({ ok: true, data: { pdfAttached: true } });

    renderWithProviders(
      <EmailReceiptDialog
        receipt={receipt}
        settings={ReceiptSettingsSchema.parse({})}
        open
        onOpenChange={onOpenChange}
      />
    );

    await user.type(screen.getByLabelText('Email'), 'ok@example.com');
    await user.click(screen.getByRole('button', { name: 'Send Receipt' }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Receipt sent.');
    });
    expect(sendReceiptByEmail).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows API error message when send fails', async () => {
    const user = userEvent.setup();
    vi.mocked(sendReceiptByEmail).mockResolvedValue({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'Resend down' },
    });

    renderWithProviders(
      <EmailReceiptDialog
        receipt={receipt}
        settings={ReceiptSettingsSchema.parse({})}
        open
        onOpenChange={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText('Email'), 'ok@example.com');
    await user.click(screen.getByRole('button', { name: 'Send Receipt' }));

    expect(await screen.findByText('Resend down')).toBeInTheDocument();
  });

  it('disables inputs while pending', async () => {
    const user = userEvent.setup();
    let resolveSend: ((v: { ok: true; data: { pdfAttached: boolean } }) => void) | undefined;
    vi.mocked(sendReceiptByEmail).mockReturnValue(
      new Promise<{ ok: true; data: { pdfAttached: boolean } }>(res => {
        resolveSend = res;
      })
    );

    renderWithProviders(
      <EmailReceiptDialog
        receipt={receipt}
        settings={ReceiptSettingsSchema.parse({})}
        open
        onOpenChange={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText('Email'), 'ok@example.com');
    await user.click(screen.getByRole('button', { name: 'Send Receipt' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sending…' })).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Email')).toBeDisabled();

    resolveSend?.({ ok: true, data: { pdfAttached: true } });
  });
});
