/**
 * Unit tests for ConfirmDialog
 *
 * Tests: confirmClassName passthrough reaches the confirm AlertDialogAction (closes Pitfall 2),
 * and that the global keydown listener is gated on idle-screen-lock state (closes CR-01,
 * 21-REVIEW.md: the listener is attached to `window`, not scoped to any DOM node, so an
 * un-gated Enter keypress could fire onConfirm -- e.g. re-submitting a payment -- while the
 * terminal is locked, D-01 "no exemption, even mid-transaction").
 */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLockStateStore } from '@shared/lib/lock-state-store';

import { ConfirmDialog } from './ConfirmDialog';

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('ConfirmDialog confirmClassName', () => {
  it('merges confirmClassName onto the confirm button, not the cancel button', () => {
    render(
      <ConfirmDialog
        open
        title="Delete item?"
        description="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        confirmClassName="min-h-[72px] focus-visible:ring-4"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    expect(confirmButton.className).toContain('min-h-[72px]');
    expect(confirmButton.className).toContain('focus-visible:ring-4');

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    expect(cancelButton.className).not.toContain('min-h-[72px]');
    expect(cancelButton.className).not.toContain('focus-visible:ring-4');
  });

  it('renders the confirm button unchanged when confirmClassName is omitted', () => {
    render(
      <ConfirmDialog
        open
        title="Confirm?"
        description="Are you sure?"
        confirmLabel="Confirm"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton.className).not.toContain('min-h-[72px]');
  });
});

describe('ConfirmDialog keyboard gating (idle-screen-lock, CR-01)', () => {
  beforeEach(() => {
    useLockStateStore.getState().setLocked(false);
  });

  it('Enter fires onConfirm and Escape fires onCancel while unlocked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Confirm?"
        description="Are you sure?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    pressKey('Enter');
    expect(onConfirm).toHaveBeenCalledTimes(1);

    pressKey('Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not fire onConfirm or onCancel on Enter/Escape while the terminal is locked', () => {
    useLockStateStore.getState().setLocked(true);
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Retry payment?"
        description="Network connection restored."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    pressKey('Enter');
    pressKey('Escape');

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('resumes responding to Enter immediately after unlock, no remount required', () => {
    useLockStateStore.getState().setLocked(true);
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Confirm?"
        description="Are you sure?"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );

    pressKey('Enter');
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => {
      useLockStateStore.getState().setLocked(false);
    });
    pressKey('Enter');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
