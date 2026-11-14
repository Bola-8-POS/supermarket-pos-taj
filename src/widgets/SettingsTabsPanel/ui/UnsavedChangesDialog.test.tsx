import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';

import { describe, expect, it, vi } from 'vitest';

// Real i18next singleton (not mocked) — same pattern as
// SettingsTabsPanel.test.tsx, resolves t('settings:unsavedChanges.*') to the
// actual en-US catalog values.
import i18n from '@shared/lib/i18n';
import { useUnsavedChangesController } from '../model/unsaved-changes';

import { UnsavedChangesDialog } from './UnsavedChangesDialog';

function renderDialog(overrides: Partial<Parameters<typeof UnsavedChangesDialog>[0]> = {}) {
  const props = {
    open: true,
    saving: false,
    saveError: false,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onStay: vi.fn(),
    ...overrides,
  };
  render(<UnsavedChangesDialog {...props} />);
  return props;
}

describe('UnsavedChangesDialog', () => {
  it('renders the title, description, and three labeled buttons', () => {
    renderDialog();

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(
      screen.getByText('Save or discard your changes before leaving this settings section.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and Continue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard Changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stay Here' })).toBeInTheDocument();
  });

  it('Stay Here has initial focus', async () => {
    renderDialog();

    expect(await screen.findByRole('button', { name: 'Stay Here' })).toHaveFocus();
  });

  it('Escape acts as Stay Here', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.keyboard('{Escape}');

    expect(props.onStay).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it('the close control acts as Stay Here', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(props.onStay).toHaveBeenCalledOnce();
  });

  it('outside click acts as Stay Here', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    // Radix AlertDialog ignores pointer-down outside by design (modal); the
    // overlay is the "outside" surface and must still route to Stay.
    const overlay = document.querySelector('[data-state="open"].fixed.inset-0');
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);

    expect(props.onStay).toHaveBeenCalledOnce();
  });

  it('Save and Continue reads Saving… and every action is disabled while saving', () => {
    renderDialog({ saving: true });

    expect(screen.getByRole('button', { name: /Saving…/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard Changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stay Here' })).toBeDisabled();
  });

  it('a failed save shows role=alert and Retry Save', () => {
    renderDialog({ saveError: true });

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't save/i);
    expect(screen.getByRole('button', { name: 'Retry Save' })).toBeEnabled();
  });

  it('no alert is shown before a failure', () => {
    renderDialog();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // The dialog is stateless; "once" is the controller's guarantee, so wire the real one.
  function ControllerHarness({ save, onContinue }: { save: () => Promise<boolean>; onContinue: () => void }) {
    const controller = useUnsavedChangesController();
    useEffect(() => {
      controller.registry.report(true, save);
    }, [controller.registry, save]);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            void controller.requestLeave().then(ok => {
              if (ok) onContinue();
            });
          }}
        >
          leave
        </button>
        <UnsavedChangesDialog {...controller.dialogProps} />
      </>
    );
  }

  it('a double click on Save and Continue sends one save and continues once', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(true);
    const onContinue = vi.fn();
    render(<ControllerHarness save={save} onContinue={onContinue} />);

    await user.click(screen.getByRole('button', { name: 'leave' }));
    await user.dblClick(await screen.findByRole('button', { name: 'Save and Continue' }));

    expect(save).toHaveBeenCalledOnce();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('a double click on Discard Changes continues once', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(<ControllerHarness save={vi.fn().mockResolvedValue(true)} onContinue={onContinue} />);

    await user.click(screen.getByRole('button', { name: 'leave' }));
    await user.dblClick(await screen.findByRole('button', { name: 'Discard Changes' }));

    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('returns focus to the opener after Stay Here', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            opener
          </button>
          <UnsavedChangesDialog
            open={open}
            saving={false}
            saveError={false}
            onSave={vi.fn()}
            onDiscard={vi.fn()}
            onStay={() => {
              setOpen(false);
            }}
          />
        </>
      );
    }
    render(<Harness />);

    const opener = screen.getByRole('button', { name: 'opener' });
    await user.click(opener);
    await user.click(await screen.findByRole('button', { name: 'Stay Here' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('renders es-MX labels', async () => {
    await i18n.changeLanguage('es-MX');
    try {
      renderDialog({ saveError: true });
      expect(screen.getByRole('button', { name: 'Reintentar guardado' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Descartar cambios' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Permanecer aquí' })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en-US');
    }
  });

  it('renders nothing when closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });
});
