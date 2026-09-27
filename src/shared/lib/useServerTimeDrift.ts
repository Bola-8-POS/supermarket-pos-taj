/**
 * Detects clock drift between the local PC clock and the Supabase server clock.
 * Returns isDrifting=true when the difference exceeds 2 minutes (120 seconds).
 *
 * Fails silently on network error — drift is set to null and isDrifting is false.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { callGetServerTime } from './edge-function-contracts';

type ServerTimeSample = {
  serverTime: string;
  /** Local timestamp (ms) captured at the moment the response arrived. */
  sampledAt: number;
};

export type ServerTimeDrift = {
  /** Absolute difference in seconds between local and server time, or null if unknown. */
  driftSeconds: number | null;
  /** True when |driftSeconds| > 120. Always false when driftSeconds is null. */
  isDrifting: boolean;
};

export function useServerTimeDrift(): ServerTimeDrift {
  const query = useQuery({
    queryKey: ['server-time'],
    queryFn: async (): Promise<ServerTimeSample | null> => {
      const sampledAt = Date.now();
      const result = await callGetServerTime();
      if (!result.ok) return null;
      return { serverTime: result.data.serverTime, sampledAt };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return useMemo(() => {
    const sample = query.data;
    if (!sample) {
      return { driftSeconds: null, isDrifting: false };
    }

    const serverMs = new Date(sample.serverTime).getTime();
    const driftSeconds = Math.round(Math.abs(serverMs - sample.sampledAt) / 1000);
    const isDrifting = driftSeconds > 120;

    return { driftSeconds, isDrifting };
  }, [query.data]);
}
