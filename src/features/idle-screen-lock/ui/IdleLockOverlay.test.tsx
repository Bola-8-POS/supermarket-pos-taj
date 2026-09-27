import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkOfflineUnlock } from '@entities/staff/model/offlineUnlock';
import { verifyStaffPin } from '@entities/staff/model/pinVerification';
import { useStaffList } from '@entities/staff/model/queries';
import { useStaffStore } from '@entities/staff/model/store';
import { isOnline } from '@shared/lib/connectivity';
import type { Staff } from '@shared/lib/domain';
import { renderWithProviders } from '@shared/lib/test-utils';

import { IdleLockOverlay } from './IdleLockOverlay';

vi.mock('@entities/staff/model/queries', () => ({
  useStaffList: vi.fn(),
}));

vi.mock('@entities/staff/model/pinVerification', () => ({
  verifyStaffPin: vi.fn(),
  findStaffPinHolder: vi.fn(),
}));

vi.mock('@shared/lib/connectivity', () => ({
  isOnline: vi.fn(),
}));

vi.mock('@entities/staff/model/offlineUnlock', () => ({
  checkOfflineUnlock: vi.fn(),
}));

const currentStaff: Staff = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Current Staff',
  role: 'cashier',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

const otherStaff: Staff = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  name: 'Other Staff',
  role: 'manager',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

describe('IdleLockOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useStaffList).mockReturnValue({
      data: [currentStaff, otherStaff],
      isIdleOrLoading: false,
    } as ReturnType<typeof useStaffList>);
    useStaffStore.setState({
      currentStaff,
      currentShift: null,
      staffList: [],
      isAuthenticated: true,
    });
  });

  function renderOverlay(onUnlock = vi.fn()) {
    renderWithProviders(<IdleLockOverlay open onUnlock={onUnlock} />);
    return { onUnlock };
  }

  async function typePin(user: ReturnType<typeof userEvent.setup>, pin: string) {
    const dialog = screen.getByRole('alertdialog');
    for (const ch of pin) {
      await user.click(
        within(dialog).getByRole('button', { name: ch === '0' ? 'Key 0' : `Key ${ch}` })
      );
    }
  }

  it('online + a match unlocks with the matched staff member (any active staff PIN, not just the signed-in one)', async () => {
    const user = userEvent.setup();
    vi.mocked(isOnline).mockReturnValue(true);
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: true,
      matches: [{ id: otherStaff.id, name: otherStaff.name, role: otherStaff.role }],
    });
    const { onUnlock } = renderOverlay();

    await typePin(user, '111111');

    await waitFor(() => {
      expect(onUnlock).toHaveBeenCalledWith(otherStaff);
    });
    expect(checkOfflineUnlock).not.toHaveBeenCalled();
  });

  it('online + INVALID_PIN shows the incorrect-PIN error', async () => {
    const user = userEvent.setup();
    vi.mocked(isOnline).mockReturnValue(true);
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'INVALID_PIN',
      retryAfter: 0,
    });
    renderOverlay();

    await typePin(user, '222222');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Incorrect PIN/i)).toBeInTheDocument();
    });
  });

  it('online + INVALID_PIN with a retry-after already armed shows the lockout message', async () => {
    const user = userEvent.setup();
    vi.mocked(isOnline).mockReturnValue(true);
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'INVALID_PIN',
      retryAfter: 30,
    });
    renderOverlay();

    await typePin(user, '777777');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Try again in 30 s/i)).toBeInTheDocument();
    });
  });

  it('online + LOCKED shows the lockout message with the retry-after seconds', async () => {
    const user = userEvent.setup();
    vi.mocked(isOnline).mockReturnValue(true);
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'LOCKED',
      retryAfter: 30,
    });
    renderOverlay();

    await typePin(user, '333333');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Try again in 30 s/i)).toBeInTheDocument();
    });
  });

  it('offline + checkOfflineUnlock resolves true unlocks with the signed-in staff member without calling verifyStaffPin', async () => {
    const user = userEvent.setup();
    vi.mocked(isOnline).mockReturnValue(false);
    vi.mocked(checkOfflineUnlock).mockResolvedValue({ ok: true });
    const { onUnlock } = renderOverlay();

    await typePin(user, '444444');

    await waitFor(() => {
      expect(onUnlock).toHaveBeenCalledWith(currentStaff);
    });
    expect(checkOfflineUnlock).toHaveBeenCalledWith(currentStaff.id, '444444');
    expect(verifyStaffPin).not.toHaveBeenCalled();
  });

  it('offline + checkOfflineUnlock resolves false shows the offline-only-same-user message', async () => {
    const user = userEvent.setup();
    vi.mocked(isOnline).mockReturnValue(false);
    vi.mocked(checkOfflineUnlock).mockResolvedValue({ ok: false, retryAfter: 0 });
    renderOverlay();

    await typePin(user, '555555');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(
        within(dialog).getByText(/No connection: only the signed-in staff member can unlock/i)
      ).toBeInTheDocument();
    });
  });

  it('online but UNAVAILABLE falls back to the offline check', async () => {
    const user = userEvent.setup();
    vi.mocked(isOnline).mockReturnValue(true);
    vi.mocked(verifyStaffPin).mockResolvedValue({
      ok: false,
      code: 'UNAVAILABLE',
      retryAfter: 0,
    });
    vi.mocked(checkOfflineUnlock).mockResolvedValue({ ok: true });
    const { onUnlock } = renderOverlay();

    await typePin(user, '666666');

    await waitFor(() => {
      expect(onUnlock).toHaveBeenCalledWith(currentStaff);
    });
    expect(checkOfflineUnlock).toHaveBeenCalledWith(currentStaff.id, '666666');
  });

  it('offline + a locked offline check shows the lockout message with the wait', async () => {
    const user = userEvent.setup();
    vi.mocked(isOnline).mockReturnValue(false);
    vi.mocked(checkOfflineUnlock).mockResolvedValue({ ok: false, retryAfter: 30 });
    renderOverlay();

    await typePin(user, '555555');

    const dialog = screen.getByRole('alertdialog');
    await waitFor(() => {
      expect(within(dialog).getByText(/Try again in 30 s/i)).toBeInTheDocument();
    });
    expect(verifyStaffPin).not.toHaveBeenCalled();
  });
});
