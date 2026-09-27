import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type * as FeaturesModule from '@shared/lib/license/features';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';

import { Sidebar } from './Sidebar';

// Cashier: RBAC denies every gated action (mirrors Sidebar.guard.test.tsx).
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

vi.mock('@features/manager-pin-gate', () => ({
  ManagerPinDialog: ({ open }: { open: boolean }) =>
    open ? <div role="alertdialog" aria-label="Manager PIN dialog" /> : null,
}));

// /audit is both RBAC-gated (cashier can't view_audit_log) AND, per this
// mock, feature-locked — RBAC must win: the manager-PIN flow, not upgrade copy.
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

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/pos']}>
      <Sidebar collapsed={false} onToggle={vi.fn()} toggleHidden={false} />
    </MemoryRouter>
  );
}

describe('Sidebar RBAC-vs-feature-lock precedence', () => {
  it('cashier on a feature-locked /audit sees the RBAC lock, not the entitlement lock, and clicking never opens the upgrade dialog', async () => {
    useUpgradeDialogStore.getState().close();
    const user = userEvent.setup();
    renderSidebar();

    const auditLink = screen.getByRole('link', { name: 'Audit Log' });
    expect(within(auditLink).queryByTestId('nav-lock-icon')).toBeInTheDocument();
    expect(within(auditLink).queryByTestId('nav-feature-lock-icon')).not.toBeInTheDocument();

    await user.click(auditLink);

    expect(useUpgradeDialogStore.getState().open).toBe(false);
    expect(screen.getByRole('alertdialog', { name: 'Manager PIN dialog' })).toBeInTheDocument();
  });
});
