import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findStaffPinHolder } from '@entities/staff/model/pinVerification';
import type { Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';

// ---------------------------------------------------------------------------
// jsdom polyfills — mirrors EditLocaleDialog.test.tsx's setup.
// ---------------------------------------------------------------------------
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

const { mutateAsyncMock, toastErrorMock, toastSuccessMock, tMock } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  tMock: vi.fn((key: string) => key),
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

const targetStaff: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Target Alex',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

vi.mock('@entities/staff/model/pinVerification', () => ({
  verifyStaffPin: vi.fn(),
  findStaffPinHolder: vi.fn(),
}));

vi.mock('../model/useAdminResetPin', () => ({
  useAdminResetPin: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
}));

vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: ({ open }: { open: boolean }) =>
    open ? <div role="alertdialog">manager-pin-gate</div> : null,
}));

import { AdminResetPinDialog } from './AdminResetPinDialog';

describe('AdminResetPinDialog', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    tMock.mockClear();
    vi.mocked(findStaffPinHolder).mockReset();
    vi.mocked(findStaffPinHolder).mockResolvedValue(null);
  });

  it('disables submit until both PIN fields are valid 6-digit matches', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminResetPinDialog staff={targetStaff} open onOpenChange={vi.fn()} />);

    const submitBtn = screen.getByRole('button', { name: 'resetPin.submit' });
    expect(submitBtn).toBeDisabled();

    await user.type(screen.getByLabelText('resetPin.newPinLabel'), '333333');
    expect(submitBtn).toBeDisabled();

    await user.type(screen.getByLabelText('resetPin.confirmPinLabel'), '333333');
    expect(submitBtn).not.toBeDisabled();
  });

  it('renders the collision warning with the name findStaffPinHolder resolves for a complete six-digit PIN', async () => {
    const user = userEvent.setup();
    vi.mocked(findStaffPinHolder).mockResolvedValue('Jamie');
    renderWithProviders(<AdminResetPinDialog staff={targetStaff} open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('resetPin.newPinLabel'), '222222');
    await user.type(screen.getByLabelText('resetPin.confirmPinLabel'), '222222');

    await waitFor(() => {
      expect(tMock).toHaveBeenCalledWith('resetPin.collisionWarning', { name: 'Jamie' });
    });
    expect(findStaffPinHolder).toHaveBeenCalledWith('222222', targetStaff.id);
    expect(screen.getByRole('button', { name: 'resetPin.submit' })).not.toBeDisabled();
  });

  it('does NOT warn when findStaffPinHolder resolves null', async () => {
    const user = userEvent.setup();
    vi.mocked(findStaffPinHolder).mockResolvedValue(null);
    renderWithProviders(<AdminResetPinDialog staff={targetStaff} open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('resetPin.newPinLabel'), '111111');
    await user.type(screen.getByLabelText('resetPin.confirmPinLabel'), '111111');

    await waitFor(() => {
      expect(findStaffPinHolder).toHaveBeenCalled();
    });
    expect(tMock).not.toHaveBeenCalledWith('resetPin.collisionWarning', expect.anything());
  });

  it('does not call findStaffPinHolder for a PIN shorter than 6 digits', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminResetPinDialog staff={targetStaff} open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('resetPin.newPinLabel'), '12345');

    expect(findStaffPinHolder).not.toHaveBeenCalled();
  });

  it('clicking the dialog submit button never calls the mutation directly — it only opens the confirm gate', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminResetPinDialog staff={targetStaff} open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('resetPin.newPinLabel'), '333333');
    await user.type(screen.getByLabelText('resetPin.confirmPinLabel'), '333333');
    await user.click(screen.getByRole('button', { name: 'resetPin.submit' }));

    // Radix's own Dialog marks sibling subtrees aria-hidden while it's open
    // (focus-trap a11y behavior) — the reused ManagerPinDialog is a real
    // sibling AlertDialog (RefundSheet.tsx composes the two the same way),
    // so `hidden: true` is required to find it, matching real DOM behavior.
    expect(screen.getByRole('alertdialog', { hidden: true })).toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });
});
