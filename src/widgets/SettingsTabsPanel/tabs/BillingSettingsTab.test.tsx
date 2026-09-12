import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mutateAsyncMock, toastErrorMock, toastSuccessMock, mockSettingsData } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  // Stable object reference — useEffect([data, ...]) fires on every render if data is recreated
  mockSettingsData: {
    billing: {
      taxRatePercent: 16,
      paymentMethods: { cash: true, card: true, bank_transfer: true, rappi: true, uber_eats: true },
      taxInclusive: true,
    },
    paymentLabels: {
      cash: 'Efectivo',
      card: 'Terminal',
      bank_transfer: 'Transferencia',
      rappi: 'Rappi',
      uber_eats: 'Uber Eats',
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock('@entities/settings', () => ({
  useSettings: () => ({ data: mockSettingsData }),
  useMutationUpdateSetting: () => ({
    mutateAsync: mutateAsyncMock,
    mutate: mutateAsyncMock,
    isPending: false,
  }),
}));

import { BillingSettingsTab } from './BillingSettingsTab';

describe('BillingSettingsTab', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });

  it('keeps local form state when save fails', async () => {
    mutateAsyncMock.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Save failed' },
    });
    const user = userEvent.setup();

    render(<BillingSettingsTab currentRole="manager" />);

    const taxInput = screen.getByLabelText('Tax rate (IVA %)');
    await user.clear(taxInput);
    await user.type(taxInput, '20');
    await user.click(screen.getByRole('button', { name: 'Save Billing' }));

    expect(toastErrorMock).toHaveBeenCalledWith('Save failed');
    expect(screen.getByLabelText('Tax rate (IVA %)').getAttribute('value')).toBe('20');
  });

  it('renders a taxInclusive toggle reflecting the live settings value', () => {
    render(<BillingSettingsTab currentRole="manager" />);

    expect(screen.getByRole('button', { name: /Included|Tax included/i })).toBeInTheDocument();
  });

  it('clicking the taxInclusive toggle then Save Billing shows a confirmation before saving (WR-03)', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();

    render(<BillingSettingsTab currentRole="manager" />);

    await user.click(screen.getByRole('button', { name: /Included/i }));
    await user.click(screen.getByRole('button', { name: 'Save Billing' }));

    // Changing taxInclusive is a store-wide price reinterpretation — the
    // mutation must NOT fire until the confirmation is accepted.
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(screen.getByText('Change how tax applies to every price?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(mutateAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'billing',
        value: expect.objectContaining({ taxInclusive: false }),
      })
    );
  });

  it('cancelling the taxInclusive confirmation dialog does not save', async () => {
    const user = userEvent.setup();

    render(<BillingSettingsTab currentRole="manager" />);

    await user.click(screen.getByRole('button', { name: /Included/i }));
    await user.click(screen.getByRole('button', { name: 'Save Billing' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('toggling taxInclusive on, off, then on again then saving calls mutation with taxInclusive: true', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();

    render(<BillingSettingsTab currentRole="manager" />);

    await user.click(screen.getByRole('button', { name: /Included/i }));
    await user.click(screen.getByRole('button', { name: /Added at checkout/i }));
    await user.click(screen.getByRole('button', { name: 'Save Billing' }));

    expect(mutateAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'billing',
        value: expect.objectContaining({ taxInclusive: true }),
      })
    );
  });

  it('saves successfully with toast on successful mutation', async () => {
    mutateAsyncMock.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();

    render(<BillingSettingsTab currentRole="manager" />);

    await user.click(screen.getByTestId('billing-method-toggle-rappi'));
    await user.click(screen.getByRole('button', { name: 'Save Billing' }));

    expect(toastSuccessMock).toHaveBeenCalledWith('Billing settings saved.');
  });

  // ── Configurable payment methods (generic 5-method list) ──────────────────

  describe('configurable payment methods', () => {
    it('renders one toggle and one label input per PAYMENT_METHODS entry', () => {
      render(<BillingSettingsTab currentRole="manager" />);

      for (const method of ['cash', 'card', 'bank_transfer', 'rappi', 'uber_eats']) {
        expect(screen.getByTestId(`billing-method-toggle-${method}`)).toBeInTheDocument();
        expect(screen.getByTestId(`billing-method-label-${method}`)).toBeInTheDocument();
      }
    });

    it('toggling uber_eats off then Save Billing saves paymentMethods.uber_eats: false', async () => {
      mutateAsyncMock.mockResolvedValueOnce({ ok: true });
      const user = userEvent.setup();

      render(<BillingSettingsTab currentRole="manager" />);

      await user.click(screen.getByTestId('billing-method-toggle-uber_eats'));
      await user.click(screen.getByRole('button', { name: 'Save Billing' }));

      expect(mutateAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'billing',
          value: expect.objectContaining({
            paymentMethods: expect.objectContaining({ uber_eats: false }),
          }),
        })
      );
    });

    it('editing the bank_transfer label then Save Labels saves the new value', async () => {
      mutateAsyncMock.mockResolvedValueOnce({ ok: true });
      const user = userEvent.setup();

      render(<BillingSettingsTab currentRole="manager" />);

      const input = screen.getByTestId('billing-method-label-bank_transfer');
      await user.clear(input);
      await user.type(input, 'Transferencia SPEI');
      await user.click(screen.getByRole('button', { name: 'Save Labels' }));

      expect(mutateAsyncMock).toHaveBeenCalledWith(
        {
          key: 'payment_labels',
          value: expect.objectContaining({ bank_transfer: 'Transferencia SPEI' }),
        },
        expect.anything()
      );
    });
  });
});
