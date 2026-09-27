import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
// Real i18next singleton (not mocked) — resolves t('settings:tabs.*') to the
// actual catalog values so these assertions double as an es-MX byte-identical
// migration check (21-03 D-04/D-05).
import '@shared/lib/i18n';
import { useNavigationGuardStore } from '@shared/lib/navigation-guard';
import { SettingsTabsPanel } from './index';

// Referenced from inside the vi.mock factory below — Vitest's hoisting only
// allows outer-scope references prefixed with "mock".
const mockSave = vi.fn<() => Promise<boolean>>();

const permissionState = {
  manageSettings: false,
  manageProducts: false,
};

const roleState: { role: 'admin' | 'manager' | 'cashier' | null } = {
  role: 'admin',
};

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (selector: (state: { currentStaff: { role: string } | null }) => unknown) =>
    selector({
      currentStaff: roleState.role ? { role: roleState.role } : null,
    }),
}));

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({
    can: (action: string) => {
      if (action === 'manage_settings') return permissionState.manageSettings;
      if (action === 'manage_products') return permissionState.manageProducts;
      return false;
    },
  }),
}));

vi.mock('./tabs/LanguageSettingsTab', () => ({
  LanguageSettingsTab: () => <div>Language tab content</div>,
}));
vi.mock('./tabs/GeneralSettingsTab', () => ({
  GeneralSettingsTab: () => <div>General tab content</div>,
}));
vi.mock('./tabs/HardwareSettingsTab', () => ({
  HardwareSettingsTab: () => <div>Hardware tab content</div>,
}));
vi.mock('./tabs/EmailReceiptsSettingsTab', () => ({
  EmailReceiptsSettingsTab: () => <div>Email tab content</div>,
}));
vi.mock('./tabs/BackupSettingsTab', () => ({
  BackupSettingsTab: () => <div>Backup tab content</div>,
}));
vi.mock('./tabs/BillingSettingsTab', () => ({
  BillingSettingsTab: () => <div>Billing tab content</div>,
}));
// A fake tab that reports itself dirty via the real registry hook — the
// import happens inside the factory (rather than at module top-level) so it
// resolves lazily, after this file's own top-level imports have settled.
vi.mock('./tabs/LockSettingsTab', async () => {
  const { useRegisterUnsavedChanges } = await import('./model/unsaved-changes');
  return {
    LockSettingsTab: () => {
      useRegisterUnsavedChanges(true, mockSave);
      return <p>lock-tab</p>;
    },
  };
});

describe('SettingsTabsPanel', () => {
  beforeEach(() => {
    permissionState.manageSettings = false;
    permissionState.manageProducts = false;
    roleState.role = 'admin';
    mockSave.mockReset();
  });

  it('shows manager tabs when only manage_products is granted', () => {
    permissionState.manageProducts = true;
    permissionState.manageSettings = false;
    roleState.role = 'manager';

    render(<SettingsTabsPanel />);

    expect(screen.queryByRole('tab', { name: 'Products' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Billing' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'General' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Backup' })).not.toBeInTheDocument();
  });

  it('shows all tabs for admin with both permissions', () => {
    permissionState.manageProducts = true;
    permissionState.manageSettings = true;
    roleState.role = 'admin';

    render(<SettingsTabsPanel />);

    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Products' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Backup' })).toBeInTheDocument();
  });

  it('shows the role-agnostic Language tab as the default tab for a cashier with neither permission (D-03, Pitfall 1)', () => {
    permissionState.manageProducts = false;
    permissionState.manageSettings = false;
    roleState.role = 'cashier';

    render(<SettingsTabsPanel />);

    // test-setup.ts pins the suite to en-US — the tab label resolves to the en-US catalog value.
    const languageTab = screen.getByRole('tab', { name: 'Language' });
    expect(languageTab).toBeInTheDocument();
    expect(languageTab).toHaveAttribute('data-state', 'active');
    expect(screen.queryByText('You do not have permission to view settings.')).not.toBeInTheDocument();
  });

  describe('unsaved-changes guard on tab switch', () => {
    beforeEach(() => {
      permissionState.manageProducts = true;
      permissionState.manageSettings = true;
      roleState.role = 'admin';
    });

    it('prompts on Cancel/Discard when leaving a dirty tab, and proceeds on Discard', async () => {
      const user = userEvent.setup();
      render(<SettingsTabsPanel />);

      await user.click(screen.getByRole('tab', { name: 'Auto-Lock Timeout' }));
      expect(await screen.findByText('lock-tab')).toBeInTheDocument();

      // Leaving the now-dirty Lock tab opens the prompt; the Lock tab stays
      // mounted (Radix hasn't switched away yet) while it's open.
      await user.click(screen.getByRole('tab', { name: 'Language' }));
      expect(await screen.findByText('Save changes?')).toBeInTheDocument();
      expect(screen.getByText('lock-tab')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByText('Save changes?')).not.toBeInTheDocument());
      expect(screen.getByText('lock-tab')).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: 'Language' }));
      expect(await screen.findByText('Save changes?')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(screen.getByText('Language tab content')).toBeInTheDocument());
      expect(screen.queryByText('lock-tab')).not.toBeInTheDocument();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('proceeds after a successful Save, calling save exactly once', async () => {
      mockSave.mockResolvedValue(true);
      const user = userEvent.setup();
      render(<SettingsTabsPanel />);

      await user.click(screen.getByRole('tab', { name: 'Auto-Lock Timeout' }));
      expect(await screen.findByText('lock-tab')).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: 'Language' }));
      expect(await screen.findByText('Save changes?')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByText('Language tab content')).toBeInTheDocument());
      expect(screen.queryByText('lock-tab')).not.toBeInTheDocument();
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it('installs a navigation guard while mounted and clears it on unmount', () => {
      const { unmount } = render(<SettingsTabsPanel />);

      expect(useNavigationGuardStore.getState().guard).not.toBeNull();

      unmount();

      expect(useNavigationGuardStore.getState().guard).toBeNull();
    });
  });
});
