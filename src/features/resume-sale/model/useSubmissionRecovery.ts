import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { findPaymentByIdempotencyKey, type PaymentLookup } from '@entities/payment';
import type { SubmissionMarker } from '@shared/lib/domain';
import type { Result } from '@shared/lib/result';
import { classifySubmissionRecovery, SUBMISSION_RECHECK_MS, type RecoveryView } from './submissionRecovery';

type Answer = { lookup: Result<PaymentLookup>; at: number };
const RECOVERY_QUERY = 'submission-recovery';

/**
 * Asks "did the sale sent under this marker's key commit?" with a read-only query. Re-queries only while the
 * answer is "not found yet, window still open"; a failed lookup is never retried automatically (the cashier
 * presses Retry Status Check). networkMode 'always': offline must produce a failed lookup (Unknown), not a
 * query paused forever as "checking". Never logs or renders the key.
 */
export function useSubmissionRecovery(marker: SubmissionMarker) {
  const [firstSeenAt] = useState(() => Date.now());
  // The clock is read when the lookup runs, so "not found" is judged against the moment it was asked.
  const classify = (answer: Answer | undefined): RecoveryView =>
    classifySubmissionRecovery({
      lookup: answer?.lookup ?? 'pending',
      startedAt: marker.startedAt,
      firstSeenAt,
      now: answer?.at ?? 0,
    });

  const query = useQuery({
    queryKey: [RECOVERY_QUERY, marker.key],
    queryFn: async (): Promise<Answer> => ({ lookup: await findPaymentByIdempotencyKey(marker.key), at: Date.now() }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: false,
    refetchInterval: q => (classify(q.state.data).kind === 'reconciling' ? SUBMISSION_RECHECK_MS : false),
  });

  const view = classify(query.data);
  const inFlight = useRef(false);
  const retryStatusCheck = () => {
    if (inFlight.current || query.isFetching) return;
    inFlight.current = true;
    void query.refetch().finally(() => {
      inFlight.current = false;
    });
  };
  return { view, retryStatusCheck, isChecking: query.isFetching };
}
