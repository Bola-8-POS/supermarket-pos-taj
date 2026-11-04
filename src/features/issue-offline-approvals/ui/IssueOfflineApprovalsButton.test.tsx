import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { rememberApprovalVerifier, storeOfflineGrants } from '@entities/staff/model/offlineApproval';
import { useOnlineStatus } from '@shared/lib/connectivity';
import type { Staff } from '@shared/lib/domain';
import type { StaffAction } from '@shared/lib/rbac';
import { ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';

import { useIssueOfflineApprovals } from '../model/useIssueOfflineApprovals';

import { IssueOfflineApprovalsButton } from './IssueOfflineApprovalsButton';

const manager: Staff = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Test Manager',
  role: 'manager',
  isActive: true,
  mustChangePin: false,
  locale: 'en-US',
};

vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: (props: {
    open: boolean;
    requiredAction: StaffAction;
    onSuccess: (staff: Staff, approvalId: string) => void;
  }) =>
    props.open ? (
      <button
        type="button"
        onClick={() => {
          props.onSuccess(manager, 'ticket-1');
        }}
      >
        {`approve ${props.requiredAction}`}
      </button>
    ) : null,
}));

vi.mock('../model/useIssueOfflineApprovals', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIssueOfflineApprovals: vi.fn(),
}));

vi.mock('@shared/lib/connectivity', () => ({
  isOnline: vi.fn(() => true),
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mutateAsync = vi.fn();

describe('IssueOfflineApprovalsButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(useOnlineStatus).mockReturnValue(true);
    mutateAsync.mockResolvedValue(ok([{}, {}, {}, {}, {}]));
    vi.mocked(useIssueOfflineApprovals).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useIssueOfflineApprovals>);
  });

  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /offline approvals/i }));
    return screen.findByRole('dialog');
  }

  it('offers only actions that can complete offline, with how many pre-approvals this terminal holds', async () => {
    await rememberApprovalVerifier(manager.id, '123456', 'manager');
    storeOfflineGrants(
      ['a', 'b'].map(id => ({
        id,
        action: 'reopen_tab',
        grantedBy: manager.id,
        requestedFor: manager.id,
        terminalId: 'POS-1',
        expiresAt: Date.now() + 60_000,
      }))
    );
    const user = userEvent.setup();
    renderWithProviders(<IssueOfflineApprovalsButton />);

    const dialog = await openDialog(user);

    const addItems = within(dialog).getByRole('listitem', { name: /add items to a reopened sale/i });
    expect(within(addItems).getByText('2 available')).toBeInTheDocument();
    // Refunds, reopening, paid-sale edits and checkout discounts cannot finish
    // without a connection yet, so no pre-approval is offered for them.
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
  });

  it('issues pre-approvals for the chosen action once a manager enters their PIN', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IssueOfflineApprovalsButton />);
    const dialog = await openDialog(user);

    await user.click(
      within(dialog).getByRole('button', { name: /issue offline approvals for add items to a reopened sale/i })
    );
    // The stand-in PIN prompt renders inline, under the modal's aria-hidden /
    // pointer-events lock (the real one is its own portal'd AlertDialog).
    fireEvent.click(await screen.findByRole('button', { name: 'approve reopen_tab', hidden: true }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        approvalId: 'ticket-1',
        approverId: manager.id,
        action: 'reopen_tab',
        count: 5,
        validMinutes: 240,
      });
    });
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/issued 5 offline approvals/i));
  });

  it('cannot issue while offline', async () => {
    vi.mocked(useOnlineStatus).mockReturnValue(false);
    const user = userEvent.setup();
    renderWithProviders(<IssueOfflineApprovalsButton />);
    const dialog = await openDialog(user);

    for (const button of within(dialog).getAllByRole('button', { name: /issue offline approvals for/i })) {
      expect(button).toBeDisabled();
    }
    expect(within(dialog).getByText(/needs a connection/i)).toBeInTheDocument();
  });
});
