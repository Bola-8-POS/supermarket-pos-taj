import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNavigationGuardStore } from '@shared/lib/navigation-guard';

import { Sidebar } from './Sidebar';

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => false }),
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentStaff: null,
      currentShift: null,
      logout: vi.fn(),
      grantManagerActions: vi.fn(),
    }),
}));

vi.mock('@entities/inventory', () => ({
  useNearExpiryAlerts: () => ({ data: undefined }),
}));

vi.mock('@entities/settings', () => ({
  useReceiptSettings: () => ({ data: undefined }),
}));

// Suppress the ManagerPinDialog query surface in unit tests (mirrors
// HomeDashboard.test.tsx) — none of these cases open it.
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: ({ open }: { open: boolean }) =>
    open ? <div role="alertdialog" aria-label="Manager PIN dialog" /> : null,
}));

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{location.pathname}</div>;
}

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/pos']}>
      <Sidebar collapsed={false} onToggle={vi.fn()} toggleHidden={false} />
      <LocationDisplay />
    </MemoryRouter>
  );
}

describe('Sidebar navigation guard', () => {
  afterEach(() => {
    useNavigationGuardStore.setState({ guard: null });
  });

  it('navigates normally when no guard is installed', async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('link', { name: 'Home' }));

    expect(screen.getByTestId('location-display')).toHaveTextContent('/home');
  });

  it('blocks the Home click while the installed guard resolves false', async () => {
    useNavigationGuardStore.getState().setGuard(() => Promise.resolve(false));
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('link', { name: 'Home' }));

    expect(screen.getByTestId('location-display')).toHaveTextContent('/pos');
  });

  it('lets the Home click through once the installed guard resolves true', async () => {
    useNavigationGuardStore.getState().setGuard(() => Promise.resolve(true));
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('link', { name: 'Home' }));

    // The click handler awaits confirmNavigation(), which here awaits a real
    // guard() Promise — one more microtask hop than the guard-less case, so
    // the navigate() call lands after user.click's own internal flush.
    await waitFor(() => {
      expect(screen.getByTestId('location-display')).toHaveTextContent('/home');
    });
  });
});
