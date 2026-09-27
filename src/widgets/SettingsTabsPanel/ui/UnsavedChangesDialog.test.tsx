import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// Real i18next singleton (not mocked) — same pattern as
// SettingsTabsPanel.test.tsx, resolves t('settings:unsavedChanges.*') to the
// actual en-US catalog values.
import '@shared/lib/i18n';

import { UnsavedChangesDialog } from './UnsavedChangesDialog';

function renderDialog(overrides: Partial<Parameters<typeof UnsavedChangesDialog>[0]> = {}) {
  const props = {
    open: true,
    saving: false,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<UnsavedChangesDialog {...props} />);
  return props;
}

describe('UnsavedChangesDialog', () => {
  it('renders the title, description, and three labeled buttons', () => {
    renderDialog();

    expect(screen.getByText('Save changes?')).toBeInTheDocument();
    expect(
      screen.getByText('You have unsaved changes on this tab. Save them before leaving?')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls onSave, onDiscard, and onCancel when the matching button is clicked', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.onSave).toHaveBeenCalledOnce();
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(props.onDiscard).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel on Escape', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.keyboard('{Escape}');

    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it('does not call onCancel on Escape while saving', async () => {
    const user = userEvent.setup();
    const props = renderDialog({ saving: true });

    await user.keyboard('{Escape}');

    expect(props.onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Save changes?')).toBeInTheDocument();
  });

  it('disables all three buttons while saving', () => {
    renderDialog({ saving: true });

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('renders nothing when closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByText('Save changes?')).not.toBeInTheDocument();
  });
});
