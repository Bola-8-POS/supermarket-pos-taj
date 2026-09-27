import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { usePermissions } from '@entities/staff/model/usePermissions';
import { renderWithProviders } from '@shared/lib/test-utils';
import { POSButton } from '@shared/ui/POSButton';
import { ProtectedAction } from './ProtectedAction';

vi.mock('@entities/staff/model/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

const mockUsePermissions = vi.mocked(usePermissions);

function allow(...allowed: string[]) {
  mockUsePermissions.mockReturnValue({ can: action => allowed.includes(action), ready: true });
}

describe('ProtectedAction', () => {
  it('renders enabled child when the action is allowed', () => {
    allow('clock_in');
    renderWithProviders(
      <ProtectedAction action="clock_in">
        <POSButton type="button">Clock in</POSButton>
      </ProtectedAction>
    );
    expect(screen.getByRole('button', { name: 'Clock in' })).not.toBeDisabled();
  });

  it('disables child and shows manager denial tooltip when the action is not allowed', async () => {
    allow();
    const user = userEvent.setup();
    renderWithProviders(
      <ProtectedAction action="process_refund">
        <POSButton type="button">Close</POSButton>
      </ProtectedAction>
    );
    const btn = screen.getByRole('button', { name: 'Close' });
    expect(btn).toBeDisabled();
    await user.hover(btn);
    const tips = await screen.findAllByText('Manager access required');
    expect(tips.length).toBeGreaterThanOrEqual(1);
  });

  it('shows admin denial for admin-only action', async () => {
    allow();
    const user = userEvent.setup();
    renderWithProviders(
      <ProtectedAction action="manage_settings">
        <POSButton type="button">Settings</POSButton>
      </ProtectedAction>
    );
    await user.hover(screen.getByRole('button', { name: 'Settings' }));
    const tips = await screen.findAllByText('Admin access required');
    expect(tips.length).toBeGreaterThanOrEqual(1);
  });

  it('merges disabled when allowed but the parent passes disabled', () => {
    allow('clock_in');
    renderWithProviders(
      <ProtectedAction action="clock_in" disabled>
        <POSButton type="button">Clock in</POSButton>
      </ProtectedAction>
    );
    expect(screen.getByRole('button', { name: 'Clock in' })).toBeDisabled();
  });

  it('passes through non-element children without tooltip', () => {
    allow('close_tab');
    const { container } = renderWithProviders(
      <ProtectedAction action="close_tab">plain text</ProtectedAction>
    );
    expect(container).toHaveTextContent('plain text');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
