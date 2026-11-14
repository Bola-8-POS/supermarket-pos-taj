import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchState = vi.fn();
vi.mock('@shared/lib/store-switch/client', () => ({
  fetchStoreSwitchState: () => fetchState(),
  backendKey: () => 'b',
  reportTillSync: () => Promise.resolve(null),
}));

import { useTabStore } from '@entities/tab/model/store';
import { useStoreSwitchStore } from '@shared/lib/store-switch/store';
import { StoreSwitchGate } from './StoreSwitchGate';

const action = (i: number) => ({
  id: `a${String(i)}`,
  type: 'place-order',
  payload: {},
  expectedVersion: 0,
  timestamp: 0,
  retryCount: 0,
  lastError: null,
  nextAttemptAt: null,
});

beforeEach(() => {
  localStorage.clear();
  fetchState.mockReset();
  fetchState.mockResolvedValue(null);
  useStoreSwitchStore.setState({ state: 'active' });
  useTabStore.setState({ offlineQueue: [] });
});

describe('StoreSwitchGate', () => {
  it('shows nothing extra while the store is active', async () => {
    fetchState.mockResolvedValue('active');
    render(
      <StoreSwitchGate>
        <button>Sell</button>
      </StoreSwitchGate>
    );
    expect(await screen.findByRole('button', { name: 'Sell' })).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('draining: blocks the till, keeps the children mounted but inert, and shows the pending count', async () => {
    fetchState.mockResolvedValue('draining');
    useTabStore.setState({ offlineQueue: [action(1), action(2)] as never });
    render(
      <StoreSwitchGate>
        <button>Sell</button>
      </StoreSwitchGate>
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('We are moving the store to its own server');
    expect(dialog).toHaveTextContent('Operations waiting to be sent: 2');
    expect(screen.getByText('Sell').closest('[inert]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Sell' })).toBeNull();
  });

  it('draining with one pending operation uses the singular wording', async () => {
    fetchState.mockResolvedValue('draining');
    useTabStore.setState({ offlineQueue: [action(1)] as never });
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Operation waiting to be sent: 1');
  });

  it('its wall sits above the schema wall (z-101 over z-100)', async () => {
    fetchState.mockResolvedValue('frozen');
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    expect(await screen.findByRole('alertdialog')).toHaveClass('z-[101]');
  });

  it('frozen has its own wording', async () => {
    fetchState.mockResolvedValue('frozen');
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Store move in progress');
  });

  it('moved: tells the till to be paired, keeps its queue count, and retry re-reads the state', async () => {
    fetchState.mockResolvedValue('moved');
    useTabStore.setState({ offlineQueue: [action(1)] as never });
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('This store moved to its own server');
    expect(dialog).toHaveTextContent('Ask an administrator to pair this till');
    expect(dialog).toHaveTextContent('Unsent operation on this till: 1');
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    fetchState.mockResolvedValue('active');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('moved with several operations uses the plural wording', async () => {
    fetchState.mockResolvedValue('moved');
    useTabStore.setState({ offlineQueue: [action(1), action(2), action(3)] as never });
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Unsent operations on this till: 3');
  });

  it('blocked: every other body child is inert (a Radix-style portal included), restored when unblocked', async () => {
    fetchState.mockResolvedValue('moved');
    const portal = document.createElement('div');
    portal.innerHTML = '<button>Dialog action</button>';
    document.body.appendChild(portal);
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(portal.hasAttribute('inert')).toBe(true);
    expect(dialog.closest('[inert]')).toBeNull();
    // a portal that appears after the block began is caught too
    const late = document.createElement('div');
    document.body.appendChild(late);
    await waitFor(() => {
      expect(late.hasAttribute('inert')).toBe(true);
    });
    fetchState.mockResolvedValue('active');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(portal.hasAttribute('inert')).toBe(false);
    });
    expect(late.hasAttribute('inert')).toBe(false);
    portal.remove();
    late.remove();
  });

  it('draining and frozen put focus on the dialog itself; moved focuses Try again', async () => {
    fetchState.mockResolvedValue('draining');
    const { unmount } = render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(dialog).toHaveFocus();
    unmount();
    useStoreSwitchStore.setState({ state: 'active' });
    fetchState.mockResolvedValue('moved');
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    expect(await screen.findByRole('button', { name: 'Try again' })).toHaveFocus();
  });

  it('Try again is a 44 px+ target, is disabled while the recheck is pending and says so if still moved', async () => {
    fetchState.mockResolvedValue('moved');
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    const button = await screen.findByRole('button', { name: 'Try again' });
    expect(button.className).toContain('h-11');
    let release: (v: 'moved') => void = () => undefined;
    fetchState.mockReturnValue(
      new Promise<'moved'>(r => {
        release = r;
      })
    );
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.queryByText(/Still not paired/)).toBeNull();
    release('moved');
    expect(await screen.findByText(/Still not paired/)).toBeVisible();
    expect(button).toBeEnabled();
  });

  it('while blocked, no key reaches a window listener, yet the button still activates from the keyboard', async () => {
    fetchState.mockResolvedValue('moved');
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    render(
      <StoreSwitchGate>
        <span>x</span>
      </StoreSwitchGate>
    );
    const button = await screen.findByRole('button', { name: 'Try again' });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(seen).not.toHaveBeenCalled();
    fetchState.mockResolvedValue('active');
    await userEvent.keyboard('{Enter}'); // focus is on Try again; Enter is its default action
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(seen).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', seen);
  });
});
