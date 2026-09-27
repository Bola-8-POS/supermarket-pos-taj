import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as ReactRouterDom from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStaffStore } from '@entities/staff/model/store';
import { usePermissions } from '@entities/staff/model/usePermissions';
import type * as FeaturesModule from '@shared/lib/license/features';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';
import { renderWithProviders } from '@shared/lib/test-utils';

import { HomeDashboard } from './HomeDashboard';

// /audit is mocked as feature-locked so precedence with RBAC can be asserted
// (a cashier is RBAC-gated on /audit regardless — RBAC must still win, per
// Sidebar.rbac-precedence.test.tsx's equivalent mock).
vi.mock('@shared/lib/license/features', async importOriginal => {
  const actual = await importOriginal<typeof FeaturesModule>();
  return {
    ...actual,
    useNavFeatureLocked: (feature: string | undefined) => ({
      locked: feature === 'audit_log',
      requestUpgrade: () => {
        useUpgradeDialogStore.getState().openFor(feature as never);
      },
    }),
  };
});

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async importOriginal => {
  const actual = await importOriginal<typeof ReactRouterDom>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: vi.fn(),
}));

// Suppress ManagerPinDialog queries in unit tests
vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: ({ open }: { open: boolean }) =>
    open ? <div role="alertdialog" aria-label="Manager PIN dialog" /> : null,
}));

const mockBartender = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  name: 'Test Bartender',
  email: 'cashier@example.com',
  role: 'cashier' as const,
  pin: '123456',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX' as const,
};

const mockManager = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Test Manager',
  email: 'manager@example.com',
  role: 'manager' as const,
  pin: '789012',
  isActive: true,
  mustChangePin: false,
  locale: 'es-MX' as const,
};

const mockLogout = vi.fn();

// Simulate Zustand selector: receives a partial state, runs the selector against it.
// Using ReturnType trick to extract the internal store state shape.
type StoreState = Parameters<Parameters<typeof useStaffStore>[0]>[0];
const mockStoreState =
  (partial: Partial<StoreState>) =>
  (fn: (s: StoreState) => unknown): unknown =>
    fn(partial as StoreState);

function setupBartender() {
  vi.mocked(usePermissions).mockReturnValue({ can: (action: string) => action === 'create_order' });
  vi.mocked(useStaffStore).mockImplementation(
    mockStoreState({ currentStaff: mockBartender, logout: mockLogout })
  );
}

function setupManager() {
  vi.mocked(usePermissions).mockReturnValue({
    can: (action: string) =>
      [
        'create_order',
        'view_reports',
        'adjust_inventory',
        'close_tab',
        'produce_prep_batch',
        'manage_waitlist',
      ].includes(action),
  });
  vi.mocked(useStaffStore).mockImplementation(
    mockStoreState({ currentStaff: mockManager, logout: mockLogout })
  );
}

describe('HomeDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBartender();
    useUpgradeDialogStore.getState().close();
  });

  it('renders all main navigation button labels', () => {
    renderWithProviders(<HomeDashboard />);
    expect(screen.getByRole('button', { name: 'Payments' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Staff' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inventory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suppliers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Roles & Permissions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audit Log' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit History' })).toBeInTheDocument();
  });

  it('shows welcome message with staff name and role', () => {
    renderWithProviders(<HomeDashboard />);
    expect(screen.getByText('Welcome, Test Bartender')).toBeInTheDocument();
    expect(screen.getByText('cashier')).toBeInTheDocument();
  });

  it('cashier clicking Payments (ungated tile) navigates directly to /payments', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeDashboard />);

    await user.click(screen.getByRole('button', { name: 'Payments' }));

    expect(mockNavigate).toHaveBeenCalledWith('/payments');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('cashier clicking Reports opens Manager PIN dialog instead of navigating', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeDashboard />);

    await user.click(screen.getByRole('button', { name: 'Reports' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('manager clicking Reports navigates directly without dialog', async () => {
    setupManager();
    const user = userEvent.setup();
    renderWithProviders(<HomeDashboard />);

    await user.click(screen.getByRole('button', { name: 'Reports' }));

    expect(mockNavigate).toHaveBeenCalledWith('/reports');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('gated buttons show lock icon for cashier', () => {
    renderWithProviders(<HomeDashboard />);
    const lockIcons = screen.getAllByTestId('lock-icon');
    // Reports, Inventory, Suppliers, Purchase Orders, Settings, Roles & Permissions,
    // Audit Log, Edit History, Promotions (Phase 27 Plan 02's admin-gated nav
    // tile) are gated for cashier
    expect(lockIcons.length).toBe(9);
  });

  it('cashier on a feature-locked Audit Log tile sees the RBAC lock (not the entitlement lock) and clicking opens the manager-PIN gate, never the upgrade dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeDashboard />);

    const auditTile = screen.getByRole('button', { name: 'Audit Log' });
    expect(within(auditTile).getByTestId('lock-icon')).toBeInTheDocument();
    expect(within(auditTile).queryByTestId('home-tile-feature-lock-icon')).not.toBeInTheDocument();

    await user.click(auditTile);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(useUpgradeDialogStore.getState().open).toBe(false);
  });

  it('logout button calls logout and navigates to /login', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeDashboard />);

    await user.click(screen.getByRole('button', { name: /logout/i }));

    expect(mockLogout).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });
});
