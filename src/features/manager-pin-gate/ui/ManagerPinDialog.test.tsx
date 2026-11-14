import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { approveOffline, availableOfflineGrants } from '@entities/staff/model/offlineApproval';
import { verifyStaffPin } from '@entities/staff/model/pinVerification';

const mockApprovalId = '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
import { useStaffList } from '@entities/staff/model/queries';
import { isOnline, useOnlineStatus } from '@shared/lib/connectivity';
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

vi.mock('@entities/staff/model/offlineApproval', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  approveOffline: vi.fn(),
  availableOfflineGrants: vi.fn(() => []),
}));

vi.mock('@shared/lib/connectivity', () => ({
  isOnline: vi.fn(() => true),
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

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
    vi.mocked(isOnline).mockReturnValue(true);
    vi.mocked(useOnlineStatus).mockReturnValue(true);
    vi.mocked(availableOfflineGrants).mockReturnValue([]);
  });

  function renderDialog(
    overrides: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
      onSuccess?: (staff: Staff, approvalId: string) => void;
      requiredAction?: StaffAction;
      offlineCapable?: boolean;
      description?: string;
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
        offlineCapable={overrides.offlineCapable ?? false}
        {...(overrides.description === undefined ? {} : { description: overrides.description })}
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

  it('the PIN gate without a description is unchanged', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Manager Access Required')).toBeInTheDocument();
    expect(
      within(dialog).getByText('A manager or admin PIN is required to access this section.')
    ).toBeInTheDocument();
    expect(within(dialog).queryByTestId('pin-gate-description')).not.toBeInTheDocument();
  });

  it('a description is shown prominently in place of the generic sentence', () => {
    renderDialog({ description: 'Write off this sale — it will NOT be recorded on the server.' });
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByTestId('pin-gate-description')).toHaveTextContent(
      'Write off this sale — it will NOT be recorded on the server.'
    );
    expect(within(dialog).queryByText(/to access this section/i)).not.toBeInTheDocument();
    // the title and the keypad are still there
    expect(within(dialog).getByText('Manager Access Required')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Key 5' })).toBeInTheDocument();
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

  // The client no longer re-checks the server's role_permissions rule (the
  // static-table "second guard" is removed: verify_staff_pin's own EXISTS
  // clause is the sole eligibility check) — a match the server names for any
  // role now succeeds as long as the matched id is still on the roster.
  it('a matched role the client never gates on directly still calls onSuccess, trusting the server match', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [{ id: mockCashier.id, name: mockCashier.name, role: mockCashier.role }],
      approvalId: mockApprovalId,
    });
    const { onSuccess } = renderDialog();

    await typePin(user, '123456');

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(mockCashier, mockApprovalId);
    });
  });

  it('a match not on the roster shows the incorrect-PIN error and does not call onSuccess', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [{ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'Off Roster', role: 'manager' }],
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

  it('UNAVAILABLE with no offline verifier shows the connection-required message', async () => {
    const user = userEvent.setup();
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'UNAVAILABLE',
      retryAfter: 0,
    });
    vi.mocked(approveOffline).mockResolvedValue({ ok: false, reason: 'no_verifier', retryAfterMs: 0 });
    renderDialog();

    await typePin(user, '000000');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Cannot check the PIN without a connection/i)).toBeInTheDocument();
    });
  });

  describe('offline approval', () => {
    const grantId = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

    it('redeems a pre-approval when the server is unreachable, attributed to its issuer', async () => {
      const user = userEvent.setup();
      vi.mocked(verifyStaffPin).mockResolvedValue({ ok: false, code: 'UNAVAILABLE', retryAfter: 0 });
      vi.mocked(approveOffline).mockResolvedValue({
        ok: true,
        approval: {
          grantId,
          action: 'process_refund',
          grantedBy: mockManager.id,
          usedBy: mockCashier.id,
          usedAt: 1,
          terminalId: 'POS-1',
        },
      });
      const { onSuccess } = renderDialog({ offlineCapable: true });

      await typePin(user, '123456');

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith(mockManager, grantId);
      });
      expect(approveOffline).toHaveBeenCalledWith('process_refund', '123456');
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/approved offline/i));
    });

    it('skips the server entirely while offline', async () => {
      const user = userEvent.setup();
      vi.mocked(isOnline).mockReturnValue(false);
      vi.mocked(approveOffline).mockResolvedValue({ ok: false, reason: 'no_grant', retryAfterMs: 0 });
      renderDialog({ offlineCapable: true });

      await typePin(user, '123456');

      await waitFor(() => {
        expect(approveOffline).toHaveBeenCalled();
      });
      expect(verifyStaffPin).not.toHaveBeenCalled();
    });

    it('says the action is not authorised offline when there is no pre-approval', async () => {
      const user = userEvent.setup();
      vi.mocked(isOnline).mockReturnValue(false);
      vi.mocked(approveOffline).mockResolvedValue({ ok: false, reason: 'no_grant', retryAfterMs: 0 });
      renderDialog({ offlineCapable: true });

      await typePin(user, '123456');

      expect(await screen.findByText(/not authorised offline/i)).toBeVisible();
    });

    it('shows the lockout countdown offline', async () => {
      const user = userEvent.setup();
      vi.mocked(isOnline).mockReturnValue(false);
      vi.mocked(approveOffline).mockResolvedValue({ ok: false, reason: 'locked_out', retryAfterMs: 60_000 });
      renderDialog({ offlineCapable: true });

      await typePin(user, '000000');

      expect(await screen.findByText(/try again in 60 s/i)).toBeVisible();
    });

    it('asks for the signed-in PIN and shows how many pre-approvals remain while offline', () => {
      vi.mocked(useOnlineStatus).mockReturnValue(false);
      vi.mocked(availableOfflineGrants).mockReturnValue([
        { id: 'a', action: 'process_refund', grantedBy: mockManager.id, requestedFor: mockManager.id, expiresAt: Date.now() + 1000, terminalId: 'POS-1' },
        { id: 'b', action: 'process_refund', grantedBy: mockManager.id, requestedFor: mockManager.id, expiresAt: Date.now() + 1000, terminalId: 'POS-1' },
      ]);
      renderDialog({ offlineCapable: true });

      const dialog = screen.getByRole('alertdialog');
      expect(within(dialog).getByText(/2 manager pre-approvals left/i)).toBeInTheDocument();
      expect(availableOfflineGrants).toHaveBeenCalledWith('process_refund');
    });

    it('keeps the keypad usable offline while the staff list cannot load', () => {
      vi.mocked(useOnlineStatus).mockReturnValue(false);
      vi.mocked(useStaffList).mockReturnValue({
        data: undefined,
        isIdleOrLoading: true,
      } as ReturnType<typeof useStaffList>);
      renderDialog({ offlineCapable: true });

      const dialog = screen.getByRole('alertdialog');
      expect(within(dialog).getByRole('button', { name: 'Key 1' })).toBeEnabled();
    });

    it('does not consult offline approval when the server answers', async () => {
      const user = userEvent.setup();
      vi.mocked(verifyStaffPin).mockResolvedValue({
        ok: true,
        matches: [{ id: mockManager.id, name: mockManager.name, role: mockManager.role }],
        approvalId: mockApprovalId,
      });
      const { onSuccess } = renderDialog({ offlineCapable: true });

      await typePin(user, '789012');

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith(mockManager, mockApprovalId);
      });
      expect(approveOffline).not.toHaveBeenCalled();
    });

    it('never redeems a pre-approval at a gate whose action cannot complete offline', async () => {
      const user = userEvent.setup();
      vi.mocked(isOnline).mockReturnValue(false);
      vi.mocked(useOnlineStatus).mockReturnValue(false);
      vi.mocked(availableOfflineGrants).mockReturnValue([
        { id: 'a', action: 'process_refund', grantedBy: mockManager.id, requestedFor: mockManager.id, expiresAt: Date.now() + 1000, terminalId: 'POS-1' },
      ]);
      renderDialog();

      const dialog = screen.getByRole('alertdialog');
      expect(within(dialog).getByText(/A manager or admin PIN is required/i)).toBeInTheDocument();
      await typePin(user, '123456');

      await waitFor(() => {
        expect(within(dialog).getByText(/Cannot check the PIN without a connection/i)).toBeInTheDocument();
      });
      expect(approveOffline).not.toHaveBeenCalled();
      expect(availableOfflineGrants).not.toHaveBeenCalled();
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
