import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';
import { POSButton } from './POSButton';
import { ProtectedAction } from './ProtectedAction';

describe('ProtectedAction', () => {
  it('renders enabled child when role allows action', () => {
    renderWithProviders(
      <ProtectedAction action="clock_in" currentRole="cashier">
        <POSButton type="button">Clock in</POSButton>
      </ProtectedAction>
    );
    expect(screen.getByRole('button', { name: 'Clock in' })).not.toBeDisabled();
  });

  it('disables child and shows manager denial tooltip when cashier lacks action', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ProtectedAction action="process_refund" currentRole="cashier">
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
    const user = userEvent.setup();
    renderWithProviders(
      <ProtectedAction action="manage_settings" currentRole="manager">
        <POSButton type="button">Settings</POSButton>
      </ProtectedAction>
    );
    await user.hover(screen.getByRole('button', { name: 'Settings' }));
    const tips = await screen.findAllByText('Admin access required');
    expect(tips.length).toBeGreaterThanOrEqual(1);
  });

  it('merges disabled when allowed but parent passes disabled', () => {
    renderWithProviders(
      <ProtectedAction action="clock_in" currentRole="cashier" disabled>
        <POSButton type="button">Clock in</POSButton>
      </ProtectedAction>
    );
    expect(screen.getByRole('button', { name: 'Clock in' })).toBeDisabled();
  });

  it('passes through non-element children without tooltip', () => {
    const { container } = renderWithProviders(
      <ProtectedAction action="close_tab" currentRole="cashier">
        plain text
      </ProtectedAction>
    );
    expect(container).toHaveTextContent('plain text');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
