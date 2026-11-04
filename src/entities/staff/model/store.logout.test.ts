import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
vi.mock('@shared/lib/supabase', () => ({
  supabase: { auth: { signOut: (...args: unknown[]) => signOut(...args) as unknown } },
}));

import type { Staff } from '@shared/lib/domain';

import { useStaffStore } from './store';

function signedIn(): void {
  useStaffStore.setState({
    currentStaff: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Test',
      role: 'cashier',
      isActive: true,
      mustChangePin: false,
      locale: 'es-MX',
    } as Staff,
    isAuthenticated: true,
  });
}

describe('useStaffStore.logout (S2B: await signOut before the app moves on)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    signedIn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the local session state synchronously', () => {
    signOut.mockReturnValue(new Promise(() => undefined));
    void useStaffStore.getState().logout();
    expect(useStaffStore.getState().isAuthenticated).toBe(false);
    expect(useStaffStore.getState().currentStaff).toBeNull();
  });

  it('resolves only after the network sign-out has answered', async () => {
    let finish: (v: { error: null }) => void = () => undefined;
    signOut.mockReturnValue(
      new Promise<{ error: null }>(resolve => {
        finish = resolve;
      })
    );
    let done = false;
    const pending = useStaffStore
      .getState()
      .logout()
      .then(() => {
        done = true;
      });
    await Promise.resolve();
    expect(done).toBe(false);
    finish({ error: null });
    await pending;
    expect(done).toBe(true);
  });

  it('does not hang when the server never answers (bounded at 3 s)', async () => {
    vi.useFakeTimers();
    signOut.mockReturnValue(new Promise(() => undefined));
    const pending = useStaffStore.getState().logout();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ ok: true, data: undefined });
  });

  it('does not throw when sign-out reports an error', async () => {
    signOut.mockResolvedValue({ error: { message: 'unreachable' } });
    await expect(useStaffStore.getState().logout()).resolves.toEqual({ ok: true, data: undefined });
    expect(useStaffStore.getState().isAuthenticated).toBe(false);
  });

  describe('signOutPending (an unconfirmed sign-out must be retried, not forgotten)', () => {
    const persisted = () =>
      (
        JSON.parse(localStorage.getItem('staff-store') ?? '{}') as {
          state?: { signOutPending?: boolean };
        }
      ).state?.signOutPending;

    it('(a) is set, and persisted, when the sign-out errors', async () => {
      signOut.mockResolvedValue({ error: { message: 'unreachable' } });
      await useStaffStore.getState().logout();
      expect(useStaffStore.getState().signOutPending).toBe(true);
      expect(persisted()).toBe(true);
    });

    it('(a) is set when the sign-out times out or throws', async () => {
      signOut.mockRejectedValue(new Error('boom'));
      await useStaffStore.getState().logout();
      expect(useStaffStore.getState().signOutPending).toBe(true);
    });

    it('(b) is cleared when the sign-out succeeds', async () => {
      useStaffStore.setState({ signOutPending: true });
      signOut.mockResolvedValue({ error: null });
      await useStaffStore.getState().logout();
      expect(useStaffStore.getState().signOutPending).toBe(false);
    });

    it('(c) login() clears it', () => {
      useStaffStore.setState({ signOutPending: true });
      useStaffStore
        .getState()
        .login(
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Test',
            role: 'cashier',
            isActive: true,
            mustChangePin: false,
            locale: 'es-MX',
          } as Staff,
          { id: 'shift-test' } as never
        );
      expect(useStaffStore.getState().signOutPending).toBe(false);
    });

    it('retrySignOut revokes only the leftover session (scope local), never every session of the staff member', async () => {
      useStaffStore.setState({ signOutPending: true });
      signOut.mockResolvedValue({ error: null });
      await useStaffStore.getState().retrySignOut();
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('retrySignOut does nothing when no sign-out is pending', async () => {
      await useStaffStore.getState().retrySignOut();
      expect(signOut).not.toHaveBeenCalled();
    });
  });
});
