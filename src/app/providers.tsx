import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { CajaListener } from '@app/CajaListener';
import { OfflineQueueProcessor } from '@app/OfflineQueueProcessor';
import { useStaffStore } from '@entities/staff/model/store';
import { useLicenseHeartbeat } from '@shared/lib/license/useLicenseHeartbeat';
import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';
import { useAppUpdater } from '@shared/lib/useAppUpdater';
import { UpdateAvailableDialog } from '@shared/ui';

function UpdaterProvider() {
  const { state, startInstall, dismissUpdate, relaunch } = useAppUpdater();
  return (
    <UpdateAvailableDialog
      state={state}
      onInstall={startInstall}
      onRemindLater={dismissUpdate}
      onDismiss={dismissUpdate}
      onRestart={relaunch}
    />
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'offlineFirst',
      staleTime: 5 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      networkMode: 'offlineFirst',
    },
  },
});

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  // Licensing: re-verify the stored token, then refresh the lease on boot / every 6 h / on reconnect.
  useLicenseHeartbeat();

  useEffect(() => {
    // Sync Zustand staffStore with the real Supabase auth session.
    // If the session disappears or the user in the JWT no longer matches
    // the persisted store, force a logout so stale credentials can't
    // bypass RLS.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const store = useStaffStore.getState();

      if (event === 'SIGNED_IN' && session) {
        void queryClient.invalidateQueries({ queryKey: ['caja'] });
        return;
      }

      // Only an EXPLICIT sign-out means the session is genuinely gone. A generic
      // `session === null` also fires on the benign `INITIAL_SESSION` snapshot
      // event — Supabase's synchronous-read-then-async-refresh startup sequence
      // can deliver that event with a transiently-null session on a hard reload
      // before the persisted token finishes restoring, which force-logged-out an
      // otherwise-valid session and stranded protected routes on /login.
      if (event === 'SIGNED_OUT') {
        if (store.isAuthenticated) {
          logger.warn('auth.session_lost', { event });
          store.logout();
          queryClient.clear();
        }
        return;
      }

      if (session === null) {
        return;
      }

      // If the JWT user doesn't match the persisted staff record, the
      // persisted session is stale (e.g. after deleting a dev user).
      if (
        store.isAuthenticated &&
        store.currentStaff !== null &&
        store.currentStaff.id !== session.user.id
      ) {
        logger.warn('auth.session_mismatch', {
          storeId: store.currentStaff.id,
          sessionId: session.user.id,
        });
        store.logout();
        queryClient.clear();
      }
    });

    return () => {
      subscription.unsubscribe();
      void supabase.removeAllChannels();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <CajaListener />
      <OfflineQueueProcessor />
      <UpdaterProvider />
      {children}
    </QueryClientProvider>
  );
}
