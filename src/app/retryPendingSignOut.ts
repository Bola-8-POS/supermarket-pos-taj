import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

import { useStaffStore } from '@entities/staff/model/store';

/**
 * An explicit logout whose server-side sign-out never confirmed (outage) leaves the cashier's
 * auth session in storage, and auth-js keeps refreshing it. When such a session resurfaces
 * (a refresh succeeded, or one was restored on boot) while nobody is signed in, finish the
 * sign-out. SIGNED_IN is never acted on: a fresh PIN sign-in must not be signed out by this.
 */
export function retryPendingSignOut(event: AuthChangeEvent, session: Session | null): void {
  if (event !== 'TOKEN_REFRESHED' && event !== 'INITIAL_SESSION') return;
  if (session === null) return;
  const store = useStaffStore.getState();
  if (!store.signOutPending || store.isAuthenticated) return;
  void store.retrySignOut();
}
