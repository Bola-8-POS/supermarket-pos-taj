/* eslint-disable import/order -- vi.mock factories must precede imports */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let statusResult: unknown;

vi.mock('./Sidebar', () => ({ Sidebar: () => <nav /> }));
vi.mock('./DemoBar', () => ({ DemoBar: () => null }));
vi.mock('@entities/store-status', () => ({
  useStoreStatus: () => ({ data: statusResult }),
  StoreConfigBanner: () => <div data-testid="store-config-banner-stub" />,
}));
vi.mock('./OfflineSalesBanner', () => ({
  OfflineSalesBanner: () => <div data-testid="offline-sales-banner" />,
}));

import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { ok } from '@shared/lib/result';
import { StoreStatusSchema } from '@shared/lib/store-status';
import { AppShell } from './AppShell';

const backupAlert = ok(
  StoreStatusSchema.parse({
    schema: 1,
    alerts: [{ code: 'BACKUP_STALE_72H', level: 'critical', since: '2026-10-01T00:00:00Z' }],
    backup: { alert: 'critical', destinations: [] },
  })
);

function renderShell() {
  render(
    <MemoryRouter>
      <AppShell />
    </MemoryRouter>
  );
}

describe('AppShell', () => {
  beforeEach(() => {
    statusResult = undefined;
    useStaffStore.setState({ currentStaff: null });
  });

  it('shows the offline sales banner inside the main content area of every routed page', () => {
    renderShell();
    expect(within(screen.getByRole('main')).getByTestId('offline-sales-banner')).toBeInTheDocument();
  });

  it('mounts the store.env banner inside the main content area', () => {
    renderShell();
    expect(within(screen.getByRole('main')).getByTestId('store-config-banner-stub')).toBeInTheDocument();
  });

  it('mounts the backup alert bar inside the main content area for an admin when a backup alert is active', () => {
    statusResult = backupAlert;
    useStaffStore.setState({ currentStaff: { role: 'admin' } as Staff });
    renderShell();
    const bar = within(screen.getByRole('main')).getByTestId('backup-alert-bar');
    expect(bar).toHaveAttribute('data-code', 'BACKUP_STALE_72H');
  });

  it('shows no backup alert bar to a cashier even with the same alert', () => {
    statusResult = backupAlert;
    useStaffStore.setState({ currentStaff: { role: 'cashier' } as Staff });
    renderShell();
    expect(screen.queryByTestId('backup-alert-bar')).not.toBeInTheDocument();
  });
});
