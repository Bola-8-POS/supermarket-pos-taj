/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLockStateStore } from '@shared/lib/lock-state-store';

import { Sidebar } from './Sidebar';

const logout = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: (msg: string) => toastError(msg) } }));

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => false }),
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentStaff: { id: 'staff-1', name: 'Test Cashier', role: 'cashier' },
      currentShift: null,
      logout,
      grantManagerActions: vi.fn(),
    }),
}));

vi.mock('@entities/inventory', () => ({
  useNearExpiryAlerts: () => ({ data: undefined }),
}));

vi.mock('@entities/settings', () => ({
  useReceiptSettings: () => ({ data: undefined }),
}));

vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: () => null,
}));

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/pos']}>
      <Sidebar collapsed={false} onToggle={vi.fn()} toggleHidden={false} />
    </MemoryRouter>
  );
}

describe('Sidebar sign-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLockStateStore.setState({ locked: false });
  });

  it('a refused sign-out locks the screen', async () => {
    logout.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OFFLINE_SALES_PENDING', message: 'Cannot sign out: 2 offline sales' },
    });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Cannot sign out: 2 offline sales');
    });
    expect(useLockStateStore.getState().locked).toBe(true);
  });

  it('a sign-out that went through does not lock the screen', async () => {
    logout.mockResolvedValueOnce({ ok: true, data: undefined });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => {
      expect(logout).toHaveBeenCalledTimes(1);
    });
    expect(useLockStateStore.getState().locked).toBe(false);
  });
});
