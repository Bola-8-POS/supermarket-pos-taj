import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as EntitySettings from '@entities/settings';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { useLockStateStore } from '@shared/lib/lock-state-store';
import { IdleLockProvider } from './IdleLockProvider';

const mockUseTerminalLockSettings = vi.fn();
vi.mock('@entities/settings', async importOriginal => {
  const actual = await importOriginal<typeof EntitySettings>();
  return {
    ...actual,
    useTerminalLockSettings: () => mockUseTerminalLockSettings(),
  };
});

const recordLock = vi.fn();
const recordUnlock = vi.fn();
vi.mock('../model/useIdleLockAudit', () => ({
  useIdleLockAudit: () => ({ recordLock, recordUnlock }),
}));

vi.mock('./IdleLockOverlay', () => ({
  IdleLockOverlay: ({ open }: { open: boolean }) => (
    <div data-testid="overlay" data-open={String(open)} />
  ),
}));

const fakeStaff: Staff = {
  id: 'staff-1',
  name: 'Test Admin',
  role: 'admin',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX',
};

describe('IdleLockProvider — persisted lock across restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTerminalLockSettings.mockReturnValue({ data: { lockTimeoutSeconds: 60 } });
    useLockStateStore.setState({ locked: false });
    useStaffStore.setState({
      hasHydrated: false,
      isAuthenticated: false,
      currentStaff: null,
      currentShift: null,
    });
  });

  it('shows the overlay on mount when locked was persisted and staff is authenticated', () => {
    useLockStateStore.setState({ locked: true });
    useStaffStore.setState({
      hasHydrated: true,
      isAuthenticated: true,
      currentStaff: fakeStaff,
      currentShift: null,
    });
    render(
      <IdleLockProvider>
        <div>app</div>
      </IdleLockProvider>
    );
    expect(screen.getByTestId('overlay')).toHaveAttribute('data-open', 'true');
    expect(recordLock).not.toHaveBeenCalled();
  });

  it('clears a stale persisted lock when hydrated and unauthenticated', () => {
    useLockStateStore.setState({ locked: true });
    useStaffStore.setState({
      hasHydrated: true,
      isAuthenticated: false,
      currentStaff: null,
      currentShift: null,
    });
    render(
      <IdleLockProvider>
        <div>app</div>
      </IdleLockProvider>
    );
    expect(useLockStateStore.getState().locked).toBe(false);
  });

  it('does NOT clear the lock before the staff store has hydrated', () => {
    useLockStateStore.setState({ locked: true });
    useStaffStore.setState({
      hasHydrated: false,
      isAuthenticated: false,
      currentStaff: null,
      currentShift: null,
    });
    render(
      <IdleLockProvider>
        <div>app</div>
      </IdleLockProvider>
    );
    expect(useLockStateStore.getState().locked).toBe(true);
  });
});
