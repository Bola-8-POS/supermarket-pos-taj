import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import '@shared/lib/i18n';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';
import { UpgradeDialog } from './UpgradeDialog';

function renderDialog() {
  return render(<UpgradeDialog activationForm={<div data-testid="fake-form" />} />);
}

describe('UpgradeDialog', () => {
  beforeEach(() => {
    useUpgradeDialogStore.getState().close();
  });

  it('shows the dialog and the feature line when opened for a specific feature', () => {
    useUpgradeDialogStore.getState().openFor('report_export');
    renderDialog();

    expect(screen.getByTestId('upgrade-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-feature-line')).toHaveTextContent(
      'Report export (CSV/PDF)'
    );
  });

  it('shows the passed activation form when "I already have a key" is clicked', async () => {
    const user = userEvent.setup();
    useUpgradeDialogStore.getState().openFor();
    renderDialog();

    expect(screen.queryByTestId('fake-form')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('upgrade-have-key'));
    expect(screen.getByTestId('fake-form')).toBeInTheDocument();
  });

  it('closes the store when "Continue the demo" is clicked', async () => {
    const user = userEvent.setup();
    useUpgradeDialogStore.getState().openFor();
    renderDialog();

    await user.click(screen.getByTestId('upgrade-close'));
    expect(useUpgradeDialogStore.getState().open).toBe(false);
  });
});
