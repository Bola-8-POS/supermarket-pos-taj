import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyStaffPin, type PinCheck } from '@entities/staff/model/pinVerification';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';
import { ClockInModal } from './ClockInModal';

const staff: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Pat',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const mutateAsync = vi.fn();

vi.mock('@entities/staff/model/queries', () => ({
  useMutationClockIn: () => ({
    mutateAsync,
    isPending: false,
    isError: false,
  }),
}));

vi.mock('@entities/staff/model/pinVerification', () => ({
  verifyStaffPin: vi.fn(),
  findStaffPinHolder: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('ClockInModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStaffStore.setState({
      currentStaff: { ...staff },
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });
  });

  it('returns null when staff is null', () => {
    const { container } = renderWithProviders(
      <ClockInModal open onOpenChange={vi.fn()} staff={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows PIN error on wrong PIN, verifying against the server for this staff member only', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'INVALID_PIN',
      retryAfter: 0,
    });
    renderWithProviders(<ClockInModal open onOpenChange={vi.fn()} staff={staff} />);

    for (const digit of '999999') {
      await user.click(screen.getByRole('button', { name: `Key ${digit}` }));
    }

    expect(await screen.findByText(/Incorrect PIN/i)).toBeInTheDocument();
    expect(verifyStaffPin).toHaveBeenCalledWith('999999', staff.id);
  });

  it('shows the lockout message when INVALID_PIN arrives with a retry-after already armed', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'INVALID_PIN',
      retryAfter: 30,
    });
    renderWithProviders(<ClockInModal open onOpenChange={vi.fn()} staff={staff} />);

    for (const digit of '999999') {
      await user.click(screen.getByRole('button', { name: `Key ${digit}` }));
    }

    expect(await screen.findByText(/Try again in 30 s/i)).toBeInTheDocument();
  });

  it('advances to opening cash and completes clock-in', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const typedPin = '123456';
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [{ id: staff.id, name: staff.name, role: staff.role }],
    });
    mutateAsync.mockResolvedValue({
      ok: true,
      data: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        staffId: staff.id,
        clockIn: new Date(),
        clockOut: null,
        openingCash: 25,
        closingCash: null,
      },
    });

    renderWithProviders(<ClockInModal open onOpenChange={onOpenChange} staff={staff} />);

    for (const digit of typedPin) {
      await user.click(screen.getByRole('button', { name: `Key ${digit}` }));
    }

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(verifyStaffPin).toHaveBeenCalledWith(typedPin, staff.id);

    const confirm = screen.getByRole('alertdialog');
    const drawerInput = within(confirm).getByLabelText(/Drawer float/i);
    await user.clear(drawerInput);
    await user.type(drawerInput, '25');
    await user.click(within(confirm).getByRole('button', { name: 'Start shift' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ staffId: staff.id, openingCash: 25 });
    });
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables the keypad Backspace button while verifyStaffPin is pending, then advances once it resolves', async () => {
    const user = userEvent.setup();
    let resolveVerify: ((value: PinCheck) => void) | undefined;
    vi.mocked(verifyStaffPin).mockImplementation(
      () =>
        new Promise<PinCheck>(resolve => {
          resolveVerify = resolve;
        })
    );

    renderWithProviders(<ClockInModal open onOpenChange={vi.fn()} staff={staff} />);

    for (const digit of '123456') {
      await user.click(screen.getByRole('button', { name: `Key ${digit}` }));
    }

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Backspace' })).toBeDisabled();
    });

    resolveVerify?.({
      ok: true,
      matches: [{ id: staff.id, name: staff.name, role: staff.role }],
    });

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
  });
});
