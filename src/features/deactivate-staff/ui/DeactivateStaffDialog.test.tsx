import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Staff } from '@shared/lib/domain';
import { err, ok } from '@shared/lib/result';
import { renderWithProviders } from '@shared/lib/test-utils';

// jsdom polyfills — mirrors AdminResetPinDialog.test.tsx's setup.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

const { mutateAsyncMock, toastErrorMock, toastSuccessMock, tMock, gateOnSuccess } = vi.hoisted(
  () => ({
    mutateAsyncMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    tMock: vi.fn((key: string) => key),
    gateOnSuccess: { current: null as (() => void) | null },
  })
);

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock('../model/useDeactivateStaff', () => ({
  useDeactivateStaff: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
}));

// The gate is a sibling AlertDialog; the test drives its onSuccess directly.
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: ({ open, onSuccess }: { open: boolean; onSuccess: () => void }) => {
    gateOnSuccess.current = onSuccess;
    return open ? <div role="alertdialog">manager-pin-gate</div> : null;
  },
}));

import { DeactivateStaffDialog } from './DeactivateStaffDialog';

const targetStaff: Staff = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Target Alex',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

async function openGateAndApprove(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'deactivate.confirm' }));
  // Radix marks sibling subtrees aria-hidden while the Dialog is open.
  expect(screen.getByRole('alertdialog', { hidden: true })).toBeInTheDocument();
  expect(mutateAsyncMock).not.toHaveBeenCalled();
  gateOnSuccess.current?.();
}

describe('DeactivateStaffDialog', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    tMock.mockClear();
    gateOnSuccess.current = null;
  });

  it('names the staff member in the title and description', () => {
    renderWithProviders(<DeactivateStaffDialog staff={targetStaff} open onOpenChange={vi.fn()} />);
    expect(tMock).toHaveBeenCalledWith('deactivate.dialogTitle', { name: 'Target Alex' });
    expect(tMock).toHaveBeenCalledWith('deactivate.dialogDescription', { name: 'Target Alex' });
  });

  it('the confirm button only opens the manager gate; the mutation runs after the gate approves', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mutateAsyncMock.mockResolvedValue(ok({ ok: true, changed: true }));
    renderWithProviders(
      <DeactivateStaffDialog staff={targetStaff} open onOpenChange={onOpenChange} />
    );

    await openGateAndApprove(user);

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({ staffId: targetStaff.id });
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith('deactivate.successToast');
    });
    expect(tMock).toHaveBeenCalledWith('deactivate.successToast', { name: 'Target Alex' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the last-admin message on STAFF_LAST_ADMIN and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mutateAsyncMock.mockResolvedValue(err({ code: 'STAFF_LAST_ADMIN', message: 'LAST_ADMIN' }));
    renderWithProviders(
      <DeactivateStaffDialog staff={targetStaff} open onOpenChange={onOpenChange} />
    );

    await openGateAndApprove(user);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('deactivate.lastAdmin');
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The manager gate closes on a refusal; only the confirm dialog stays.
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog', { hidden: true })).not.toBeInTheDocument();
    });
  });

  it('shows the partial-failure message on STAFF_DEACTIVATE_PARTIAL_FAILURE', async () => {
    const user = userEvent.setup();
    mutateAsyncMock.mockResolvedValue(
      err({ code: 'STAFF_DEACTIVATE_PARTIAL_FAILURE', message: 'PARTIAL_FAILURE: sync' })
    );
    renderWithProviders(<DeactivateStaffDialog staff={targetStaff} open onOpenChange={vi.fn()} />);

    await openGateAndApprove(user);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('deactivate.partialFailureToast');
    });
  });

  it('shows the generic message on any other failure', async () => {
    const user = userEvent.setup();
    mutateAsyncMock.mockResolvedValue(err({ code: 'SUPABASE_ERROR', message: 'boom' }));
    renderWithProviders(<DeactivateStaffDialog staff={targetStaff} open onOpenChange={vi.fn()} />);

    await openGateAndApprove(user);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('deactivate.genericFailure');
    });
  });
});
