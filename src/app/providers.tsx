import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { CajaListener } from '@app/CajaListener';
import { NearExpiryPricingWarmer } from '@app/NearExpiryPricingWarmer';
import { OfflineQueueProcessor } from '@app/OfflineQueueProcessor';
import { OfflineSaleReplayer } from '@app/OfflineSaleReplayer';
import { StoreSwitchReporter } from '@app/StoreSwitchReporter';
import {
  APP_CACHE_BUSTER,
  DEHYDRATE_OPTIONS,
  PERSIST_MAX_AGE_MS,
  createIdbPersister,
  keepLastGoodData,
  syncOnlineManagerWithConnectivity,
} from '@app/queryPersister';
import { OfflineApprovalReporter } from '@features/issue-offline-approvals';
import { useStaffStore } from '@entities/staff/model/store';
import { startConnectivityMonitor } from '@shared/lib/connectivity';
import { useLicenseHeartbeat } from '@shared/lib/license/useLicenseHeartbeat';
import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';
import { useAppUpdater } from '@shared/lib/useAppUpdater';
import { UpdateAvailableDialog } from '@shared/ui';
import { retryPendingSignOut } from './retryPendingSignOut';

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
keepLastGoodData(queryClient);
syncOnlineManagerWithConnectivity();

const persistOptions = {
  persister: createIdbPersister(),
  maxAge: PERSIST_MAX_AGE_MS,
  buster: APP_CACHE_BUSTER,
  dehydrateOptions: DEHYDRATE_OPTIONS,
};

function onCacheRestored() {
  // Restored from disk: let anything stale refetch in the background once online.
  void queryClient.invalidateQueries();
}

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  // Licensing: re-verify the stored token, then refresh the lease on boot / every 6 h / on reconnect.
  useLicenseHeartbeat();

  // Reachability probe behind isOnline()/useOnlineStatus(): navigator.onLine alone
  // misses a live network card with a dead uplink.
  useEffect(() => startConnectivityMonitor(), []);

  useEffect(() => {
    // Sync Zustand staffStore with the real Supabase auth session.
    // If the session disappears or the user in the JWT no longer matches
    // the persisted store, force a logout so stale credentials can't
    // bypass RLS.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const store = useStaffStore.getState();

      retryPendingSignOut(event, session);

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
          void store.logout({ force: true });
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
        void store.logout({ force: true });
        queryClient.clear();
      }
    });

    return () => {
      subscription.unsubscribe();
      void supabase.removeAllChannels();
    };
  }, []);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
      onSuccess={onCacheRestored}
    >
      <CajaListener />
      <OfflineQueueProcessor />
      <StoreSwitchReporter />
      <OfflineSaleReplayer />
      <NearExpiryPricingWarmer />
      <OfflineApprovalReporter />
      <UpdaterProvider />
      {children}
    </PersistQueryClientProvider>
  );
}
