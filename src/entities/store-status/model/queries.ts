/* eslint-disable i18next/no-literal-string -- query-key namespace string, not UI copy */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { logger } from '@shared/lib/logger';
import { err, type Result } from '@shared/lib/result';
import { getStoreMode } from '@shared/lib/store-mode';
import { fetchStoreStatus, isStoreServerUrl, type StoreStatus } from '@shared/lib/store-status';
import { getBackendAnonKey, getBackendUrl, StoreConfigInvalidError } from '@shared/lib/supabase';

let warnedUnusable = false;

/** The backend this terminal talks to; null when it is not configured yet or the config is unusable. */
export function currentEndpoint(): { url: string; anonKey: string } | null {
  try {
    const url = getBackendUrl();
    const anonKey = getBackendAnonKey();
    return url && anonKey ? { url, anonKey } : null;
  } catch (e) {
    if (!warnedUnusable) {
      warnedUnusable = true;
      // the code only: never the URL or the key
      logger.warn('store_status.endpoint_unusable', { code: e instanceof StoreConfigInvalidError ? e.appError.code : 'UNKNOWN_ERROR' });
    }
    return null;
  }
}

const POLL_MS = 60_000;
const BACKOFF_MS = 5 * 60_000;

/**
 * The store server's status (backup alerts among other things). Only asks when the backend is not a
 * hosted Supabase project. Polls once a minute while it answers; if it has never answered OK it stops after
 * the first non-answer (a hosted or older backend has no such endpoint), and once it has answered OK a
 * failed poll keeps the last good data and retries every 5 minutes.
 */
export function useStoreStatus(options: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const lastFailed = useRef(false);
  const endpoint = currentEndpoint();
  const eligible = options.enabled && endpoint !== null && getStoreMode() !== 'cloud' && isStoreServerUrl(endpoint.url);
  const queryKey = ['store-status', endpoint?.url ?? null];
  return useQuery<Result<StoreStatus>>({
    queryKey,
    enabled: eligible,
    staleTime: 30_000,
    retry: false,
    // the kept data is the last OK answer, so "has data and it is ok" means the server has answered before
    refetchInterval: query => (query.state.data?.ok !== true ? false : lastFailed.current ? BACKOFF_MS : POLL_MS),
    queryFn: async ({ signal }) => {
      if (!endpoint) return err({ code: 'NOT_FOUND', message: 'no backend configured' });
      const r = await fetchStoreStatus(endpoint, signal);
      lastFailed.current = !r.ok;
      if (r.ok) return r;
      const previous = queryClient.getQueryData<Result<StoreStatus>>(queryKey);
      return previous?.ok === true ? previous : r;
    },
  });
}
