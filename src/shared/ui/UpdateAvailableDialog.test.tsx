/**
 * Unit tests for UpdateAvailableDialog.
 *
 * UPD-03: dialog shows version + changelog in idle state
 * UPD-04: Install Now button triggers onInstall
 * UPD-05: Remind Later calls onRemindLater
 * UPD-08: progress bar renders with percent value
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@shared/lib/test-utils';
import type { UpdaterState } from '@shared/lib/useAppUpdater';
import { UpdateAvailableDialog } from './UpdateAvailableDialog';

function renderDialog(
  state: UpdaterState,
  overrides: Partial<React.ComponentProps<typeof UpdateAvailableDialog>> = {}
) {
  return renderWithProviders(
    <UpdateAvailableDialog
      state={state}
      onInstall={vi.fn()}
      onRemindLater={vi.fn()}
      onDismiss={vi.fn()}
      onRestart={vi.fn().mockResolvedValue(undefined) as () => Promise<void>}
      {...overrides}
    />
  );
}

describe('UpdateAvailableDialog', () => {
  it('shows version and changelog in idle state (UPD-03)', async () => {
    renderDialog({ phase: 'available', version: '2.1.0', changelog: '- fixes' });
    expect(screen.getByText('Update Available')).toBeInTheDocument();
    expect(screen.getByText('Version 2.1.0 is ready to install.')).toBeInTheDocument();
    expect(screen.getByText('- fixes')).toBeInTheDocument();
  });

  it('Install Now button calls onInstall (UPD-04)', async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn().mockResolvedValue(undefined);
    renderDialog({ phase: 'available', version: '2.1.0', changelog: '' }, { onInstall });
    await user.click(screen.getByRole('button', { name: 'Install Now' }));
    expect(onInstall).toHaveBeenCalled();
  });

  it('Remind Later calls onRemindLater (UPD-05)', async () => {
    const user = userEvent.setup();
    const onRemindLater = vi.fn();
    renderDialog({ phase: 'available', version: '2.1.0', changelog: '' }, { onRemindLater });
    await user.click(screen.getByRole('button', { name: 'Remind Later' }));
    expect(onRemindLater).toHaveBeenCalled();
  });

  it('progress bar visible with correct value in downloading state (UPD-08)', async () => {
    renderDialog({ phase: 'downloading', version: '2.1.0', percent: 42 });
    expect(screen.getByTestId('update-progress')).toBeInTheDocument();
    expect(screen.getByText('Downloading 42%')).toBeInTheDocument();
  });

  it('buttons are disabled during downloading state', async () => {
    renderDialog({ phase: 'downloading', version: '2.1.0', percent: 10 });
    const remindBtn = screen.getByRole('button', { name: 'Remind Later' });
    const installBtn = screen.getByRole('button', { name: /Installing/i });
    expect(remindBtn).toBeDisabled();
    expect(installBtn).toBeDisabled();
  });

  it('Restart Now button visible in restart-ready state', async () => {
    renderDialog({ phase: 'restart-ready', version: '2.1.0' });
    expect(screen.getByRole('button', { name: 'Restart Now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
  });

  it('Close button visible in error state', async () => {
    renderDialog({ phase: 'error' });
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByText('Update Failed')).toBeInTheDocument();
  });
});
