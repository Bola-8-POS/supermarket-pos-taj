import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
vi.mock('@shared/lib/supabase', () => ({
  supabase: { auth: { signOut: (...args: unknown[]) => signOut(...args) as unknown } },
}));

import { useStaffStore } from '@entities/staff/model/store';

import { retryPendingSignOut } from './retryPendingSignOut';

const session = { access_token: 'test-access-token' } as Session;

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('retryPendingSignOut (listener side of signOutPending)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    signOut.mockResolvedValue({ error: null });
    useStaffStore.setState({ isAuthenticated: false, currentStaff: null, signOutPending: true });
  });

  it('(d) TOKEN_REFRESHED while signed out with the flag set signs out again and clears the flag', async () => {
    retryPendingSignOut('TOKEN_REFRESHED', session);
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useStaffStore.getState().signOutPending).toBe(false);
  });

  it('keeps the flag when the retry fails', async () => {
    signOut.mockResolvedValue({ error: { message: 'still down' } });
    retryPendingSignOut('TOKEN_REFRESHED', session);
    await flush();
    expect(useStaffStore.getState().signOutPending).toBe(true);
  });

  it('(e) SIGNED_IN never triggers a sign-out', async () => {
    retryPendingSignOut('SIGNED_IN', session);
    await flush();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('(f) TOKEN_REFRESHED while authenticated never triggers a sign-out', async () => {
    useStaffStore.setState({ isAuthenticated: true });
    retryPendingSignOut('TOKEN_REFRESHED', session);
    await flush();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('(g) INITIAL_SESSION on boot with the flag set and nobody signed in signs out', async () => {
    retryPendingSignOut('INITIAL_SESSION', session);
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('ignores a null session and an unset flag', async () => {
    retryPendingSignOut('INITIAL_SESSION', null);
    useStaffStore.setState({ signOutPending: false });
    retryPendingSignOut('TOKEN_REFRESHED', session);
    await flush();
    expect(signOut).not.toHaveBeenCalled();
  });
});
