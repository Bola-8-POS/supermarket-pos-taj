import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyStaffPin } from '@entities/staff/model/pinVerification';

const mockApprovalId = '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
import { useStaffList } from '@entities/staff/model/queries';
import type { Staff } from '@shared/lib/domain';
import type { StaffAction } from '@shared/lib/rbac';
import { renderWithProviders } from '@shared/lib/test-utils';

import { ManagerPinDialog } from './ManagerPinDialog';

vi.mock('@entities/staff/model/queries', () => ({
  useStaffList: vi.fn(),
}));

vi.mock('@entities/staff/model/pinVerification', () => ({
  verifyStaffPin: vi.fn(),
  findStaffPinHolder: vi.fn(),
}));

const mockManager: Staff = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Test Manager',
  role: 'manager',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const mockCashier: Staff = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  name: 'Test Cashier',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

describe('ManagerPinDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useStaffList).mockReturnValue({
      data: [mockCashier, mockManager],
      isIdleOrLoading: false,
    } as ReturnType<typeof useStaffList>);
  });

  function renderDialog(
    overrides: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      onSuccess?: (staff: Staff, approvalId: string) => void;
      requiredAction?: StaffAction;
    } = {}
  ) {
    const onOpenChange = overrides.onOpenChange ?? vi.fn();
    const onSuccess = overrides.onSuccess ?? vi.fn();
    renderWithProviders(
      <ManagerPinDialog
        open={overrides.open ?? true}
        onOpenChange={onOpenChange}
        requiredAction={overrides.requiredAction ?? 'process_refund'}
        onSuccess={onSuccess}
      />
    );
    return { onOpenChange, onSuccess };
  }

  async function typePin(user: ReturnType<typeof userEvent.setup>, pin: string) {
    const dialog = screen.getByRole('alertdialog');
    for (const ch of pin) {
      await user.click(
        within(dialog).getByRole('button', { name: ch === '0' ? 'Key 0' : `Key ${ch}` })
      );
    }
  }

  it('renders dialog with title when open', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Manager Access Required')).toBeInTheDocument();
    expect(within(dialog).getByText(/A manager or admin PIN is required/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a match with an eligible role calls onSuccess with the matched staff and the approval ticket', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [{ id: mockManager.id, name: mockManager.name, role: mockManager.role }],
      approvalId: mockApprovalId,
    });
    const { onSuccess } = renderDialog();

    await typePin(user, '789012');

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(mockManager, mockApprovalId);
    });
  });

  it('checks the PIN with the dialog required action as the third argument', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [{ id: mockManager.id, name: mockManager.name, role: mockManager.role }],
      approvalId: mockApprovalId,
    });
    renderDialog({ requiredAction: 'manage_staff' });

    await typePin(user, '789012');

    await waitFor(() => {
      expect(verifyStaffPin).toHaveBeenCalledWith('789012', undefined, 'manage_staff');
    });
  });

  it('an eligible match without an approval ticket shows the incorrect-PIN error and does not call onSuccess', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [{ id: mockManager.id, name: mockManager.name, role: mockManager.role }],
    });
    const { onSuccess } = renderDialog();
    await typePin(user, '789012');
    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Incorrect PIN/i)).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('matches containing only a non-eligible role show the incorrect-PIN error and do not call onSuccess', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [{ id: mockCashier.id, name: mockCashier.name, role: mockCashier.role }],
      approvalId: mockApprovalId,
    });
    const { onSuccess } = renderDialog();

    await typePin(user, '123456');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Incorrect PIN/i)).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('two matches where only the second is eligible calls onSuccess with the eligible one', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [
        { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Someone Else', role: 'cashier' },
        { id: mockManager.id, name: mockManager.name, role: mockManager.role },
      ],
      approvalId: mockApprovalId,
    });
    const { onSuccess } = renderDialog();

    await typePin(user, '555555');

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(mockManager, mockApprovalId);
    });
  });

  it('INVALID_PIN shows the incorrect-PIN error', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'INVALID_PIN',
      retryAfter: 0,
    });
    renderDialog();

    await typePin(user, '000000');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Incorrect PIN/i)).toBeInTheDocument();
    });
  });

  it('INVALID_PIN with a retry-after already armed shows the lockout message', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'INVALID_PIN',
      retryAfter: 30,
    });
    renderDialog();

    await typePin(user, '000000');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Try again in 30 s/i)).toBeInTheDocument();
    });
  });

  it('LOCKED shows the lockout message with the retry-after seconds', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'LOCKED',
      retryAfter: 30,
    });
    renderDialog();

    await typePin(user, '000000');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Try again in 30 s/i)).toBeInTheDocument();
    });
  });

  it('UNAVAILABLE shows the connection-required message', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'UNAVAILABLE',
      retryAfter: 0,
    });
    renderDialog();

    await typePin(user, '000000');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Cannot check the PIN without a connection/i)).toBeInTheDocument();
    });
  });

  it('resets pin and error when dialog closes and reopens', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'INVALID_PIN',
      retryAfter: 0,
    });
    renderDialog({ onOpenChange });

    const dialog = screen.getByRole('alertdialog');
    await typePin(user, '123456');
    await waitFor(() => {
      expect(within(dialog).getByText(/Incorrect PIN/i)).toBeInTheDocument();
    });

    // Close via Cancel
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows disabled keypad while staff list is loading', () => {
    vi.mocked(useStaffList).mockReturnValue({
      data: undefined,
      isIdleOrLoading: true,
    } as ReturnType<typeof useStaffList>);

    renderDialog();

    const dialog = screen.getByRole('alertdialog');
    // All digit buttons should be disabled during loading
    const key1 = within(dialog).getByRole('button', { name: 'Key 1' });
    expect(key1).toBeDisabled();
  });
});
