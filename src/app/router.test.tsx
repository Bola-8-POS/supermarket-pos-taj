import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStaffStore } from '@entities/staff/model/store';
import { mockStaff } from '@entities/staff/model/types';
import type { Shift } from '@shared/lib/domain';

vi.mock('@widgets/AppShell', () => ({ AppShell: () => <div>Shell</div> }));
vi.mock('@widgets/HelpSheet', () => ({ HelpSheet: () => null }));
vi.mock('@features/agent-chat', () => ({ AgentPanel: () => <div>AgentPanel mounted</div> }));

vi.mock('../pages/login', () => ({ default: () => <div>login page</div> }));
vi.mock('../pages/home', () => ({ default: () => <div>home page</div> }));
vi.mock('../pages/inventory', () => ({ default: () => <div>inventory page</div> }));
vi.mock('../pages/suppliers', () => ({ default: () => <div>suppliers page</div> }));
vi.mock('../pages/staff', () => ({ default: () => <div>staff page</div> }));
vi.mock('../pages/reports', () => ({ default: () => <div>reports page</div> }));
vi.mock('../pages/settings', () => ({ default: () => <div>settings page</div> }));
vi.mock('../pages/payments', () => ({ default: () => <div>payments page</div> }));
vi.mock('../pages/pos', () => ({ default: () => <div>pos page</div> }));
vi.mock('../pages/rbac', () => ({ default: () => <div>rbac page</div> }));
vi.mock('../pages/audit', () => ({ default: () => <div>audit page</div> }));
vi.mock('../pages/edit-history', () => ({ default: () => <div>edit-history page</div> }));
vi.mock('../pages/purchase-orders', () => ({ default: () => <div>purchase-orders page</div> }));
vi.mock('../pages/promotions', () => ({ default: () => <div>promotions page</div> }));

// eslint-disable-next-line import/first -- Router must be imported after the vi.mock calls above.
import { Router } from './router';

const testShift: Shift = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  staffId: mockStaff[0]!.id,
  clockIn: new Date(),
  clockOut: null,
  openingCash: 0,
  closingCash: null,
};

describe('Router — AgentPanel auth gating', () => {
  beforeEach(() => {
    useStaffStore.getState().logout();
    useStaffStore.setState({ hasHydrated: true });
  });

  it('does not mount AgentPanel on /login before any staff is authenticated', async () => {
    window.history.pushState({}, '', '/login');
    render(<Router />);

    await waitFor(() => {
      expect(screen.getByText('login page')).toBeInTheDocument();
    });
    expect(screen.queryByText('AgentPanel mounted')).not.toBeInTheDocument();
  });

  it('mounts AgentPanel once a staff member is authenticated', async () => {
    useStaffStore.getState().login(mockStaff[0]!, testShift);
    window.history.pushState({}, '', '/home');
    render(<Router />);

    await waitFor(() => {
      expect(screen.getByText('AgentPanel mounted')).toBeInTheDocument();
    });
  });
});
