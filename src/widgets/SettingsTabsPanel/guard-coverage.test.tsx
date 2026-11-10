/**
 * D-11 guard coverage for the Settings panel: every editable tab registers with
 * the one exit guard, reload / window close raise the native beforeunload
 * warning, and a Tauri close and browser back go through the three-action
 * dialog. Tabs are stubbed (a fake Lock tab reports dirty through the real
 * registry hook), the guard wiring under test is the real panel.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@shared/lib/i18n';

import indexSource from './index.tsx?raw';
import { SettingsTabsPanel } from './index';

const tauri = vi.hoisted(() => ({
  isTauri: false,
  handler: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  destroy: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => tauri.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: tauri.destroy,
    onCloseRequested: (cb: NonNullable<typeof tauri.handler>) => {
      tauri.handler = cb;
      return Promise.resolve(() => undefined);
    },
  }),
}));

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (selector: (state: { currentStaff: { role: string } }) => unknown) =>
    selector({ currentStaff: { role: 'admin' } }),
}));
vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: () => ({ can: () => true }),
}));

vi.mock('./tabs/LanguageSettingsTab', () => ({ LanguageSettingsTab: () => <div>Language tab content</div> }));
vi.mock('./tabs/GeneralSettingsTab', () => ({ GeneralSettingsTab: () => <div>General tab content</div> }));
vi.mock('./tabs/HardwareSettingsTab', () => ({ HardwareSettingsTab: () => <div>Hardware tab content</div> }));
vi.mock('./tabs/EmailReceiptsSettingsTab', () => ({ EmailReceiptsSettingsTab: () => <div>Email tab content</div> }));
vi.mock('./tabs/BackupSettingsTab', () => ({ BackupSettingsTab: () => <div>Backup tab content</div> }));
vi.mock('./tabs/BillingSettingsTab', () => ({ BillingSettingsTab: () => <div>Billing tab content</div> }));
vi.mock('./tabs/LicenseSettingsTab', () => ({ LicenseSettingsTab: () => <div>License tab content</div> }));
vi.mock('./tabs/NearExpirySettingsTab', () => ({ NearExpirySettingsTab: () => <div>Near expiry tab content</div> }));
vi.mock('./tabs/LockSettingsTab', async () => {
  const { useRegisterUnsavedChanges } = await import('./model/unsaved-changes');
  return {
    LockSettingsTab: () => {
      useRegisterUnsavedChanges(true, () => Promise.resolve(true));
      return <p>lock-tab</p>;
    },
  };
});

// D-16a: License activation and Backup never register a draft.
const EXEMPT = ['BackupSettingsTab', 'LicenseSettingsTab'];

const tabSources = import.meta.glob<string>('./tabs/*SettingsTab.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('registry coverage', () => {
  const rendered = [...indexSource.matchAll(/render: \(\) => <(\w+SettingsTab) \/>/g)].map(m => m[1] ?? '');
  const registered = Object.entries(tabSources)
    .filter(([, source]) => source.includes('useRegisterUnsavedChanges('))
    .map(([path]) => /\/(\w+)\.tsx$/.exec(path)?.[1] ?? '');

  it('every registry tab except License activation and Backup registers with the guard', () => {
    expect(rendered.length).toBeGreaterThan(0);
    for (const tab of rendered.filter(name => !EXEMPT.includes(name))) {
      expect(registered, tab).toContain(tab);
    }
  });

  it('registered tab ids equal registry ids minus the exempt list', () => {
    expect([...registered].sort()).toEqual(rendered.filter(name => !EXEMPT.includes(name)).sort());
  });
});

describe('native and window exits', () => {
  beforeEach(() => {
    tauri.isTauri = false;
    tauri.handler = null;
    tauri.destroy.mockReset();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  async function openDirtyLockTab(user: ReturnType<typeof userEvent.setup>) {
    render(<SettingsTabsPanel />);
    await user.click(screen.getByRole('tab', { name: /Auto-Lock Timeout/ }));
    expect(await screen.findByText('lock-tab')).toBeInTheDocument();
  }

  function fireBeforeUnload() {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it('beforeunload while dirty is prevented; while clean it is not', async () => {
    const user = userEvent.setup();
    render(<SettingsTabsPanel />);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    await user.click(screen.getByRole('tab', { name: /Auto-Lock Timeout/ }));
    await screen.findByText('lock-tab');
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
  });

  it('Tauri close-requested while dirty prevents the close and opens the guard', async () => {
    tauri.isTauri = true;
    const user = userEvent.setup();
    await openDirtyLockTab(user);
    await waitFor(() => { expect(tauri.handler).not.toBeNull(); });

    const preventDefault = vi.fn();
    act(() => {
      void tauri.handler?.({ preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(tauri.destroy).not.toHaveBeenCalled();
  });

  it('Stay Here after a Tauri close keeps the window open', async () => {
    tauri.isTauri = true;
    const user = userEvent.setup();
    await openDirtyLockTab(user);
    await waitFor(() => { expect(tauri.handler).not.toBeNull(); });
    act(() => {
      void tauri.handler?.({ preventDefault: vi.fn() });
    });

    await user.click(await screen.findByRole('button', { name: 'Stay Here' }));

    await waitFor(() => { expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument(); });
    expect(tauri.destroy).not.toHaveBeenCalled();
  });

  it('Discard Changes after a Tauri close closes the window exactly once', async () => {
    tauri.isTauri = true;
    const user = userEvent.setup();
    await openDirtyLockTab(user);
    await waitFor(() => { expect(tauri.handler).not.toBeNull(); });
    act(() => {
      void tauri.handler?.({ preventDefault: vi.fn() });
    });

    await user.dblClick(await screen.findByRole('button', { name: 'Discard Changes' }));

    await waitFor(() => { expect(tauri.destroy).toHaveBeenCalledTimes(1); });
  });

  it('Tauri close while clean closes at once with no dialog', async () => {
    tauri.isTauri = true;
    render(<SettingsTabsPanel />);
    await waitFor(() => { expect(tauri.handler).not.toBeNull(); });

    const preventDefault = vi.fn();
    await tauri.handler?.({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('browser back while dirty opens the guard and Stay Here keeps the URL', async () => {
    window.history.pushState(null, '', '/prev');
    window.history.pushState(null, '', '/settings');
    const user = userEvent.setup();
    await openDirtyLockTab(user);

    const popped = new Promise<void>(resolve => {
      window.addEventListener('popstate', () => { resolve(); }, { once: true });
    });
    window.history.back();
    await popped;

    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stay Here' }));
    await waitFor(() => { expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument(); });
    expect(window.location.pathname).toBe('/settings');
  });
});
