import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useMutationOpenTab } from '@entities/tab/model/queries';
import { useMutationAddOrder } from '@entities/tab/model/queries';
import { useTabStore, type OfflineAction } from '@entities/tab/model/store';
import { useOnlineStatus } from '@shared/lib/connectivity';
import { logger } from '@shared/lib/logger-instance';
import { formatDiscardedSummary } from '@shared/lib/offline-summary';
import { supabase } from '@shared/lib/supabase';
import { getTerminalId } from '@shared/lib/terminal';

const ENTITY_BY_ACTION_TYPE: Record<OfflineAction['type'], string> = {
  'open-tab': 'tabs',
  'place-order': 'tabs',
  'start-pool-timer': 'pool_sessions',
  'stop-pool-timer': 'pool_sessions',
};

function payloadEntityId(action: OfflineAction): string | null {
  const p = action.payload;
  if (p == null || typeof p !== 'object') return null;
  const obj = p as Record<string, unknown>;
  if (typeof obj['tabId'] === 'string') return obj['tabId'];
  if (typeof obj['sessionId'] === 'string') return obj['sessionId'];
  if (typeof obj['tableId'] === 'string') return obj['tableId'];
  return null;
}

function writeDiscardAuditAsync(action: OfflineAction): void {
  void Promise.resolve()
    .then(async () => {
      const res = await supabase.rpc('record_audit', {
        p_action: 'offline.discarded_stale',
        p_entity_type: ENTITY_BY_ACTION_TYPE[action.type],
        p_entity_id: payloadEntityId(action),
        p_before: { expectedVersion: action.expectedVersion, action_type: action.type },
        p_after: null,
        p_terminal_id: getTerminalId(),
        p_user_id: null,
      } as never);
      if (res.error) {
        logger.warn('offline.queue.replay.audit_failed', {
          actionId: action.id,
          message: res.error.message,
        });
      }
    })
    .catch((e: unknown) => {
      logger.warn('offline.queue.replay.audit_threw', { actionId: action.id, error: e });
    });
}

/**
 * Headless component that replays the offline action queue when connectivity
 * returns. Must be rendered inside <QueryClientProvider>.
 *
 * Actions are replayed sequentially in the order they were enqueued.
 * Each action is dequeued regardless of outcome (to avoid infinite retries).
 */
export function OfflineQueueProcessor() {
  const isOnline = useOnlineStatus();
  const wasOnlineRef = useRef<boolean>(isOnline);
  const isReplayingRef = useRef<boolean>(false);

  const openTab = useMutationOpenTab();
  const addOrder = useMutationAddOrder();

  useEffect(() => {
    const previouslyOnline = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;

    const transitionedOnline = isOnline && !previouslyOnline;
    if (!transitionedOnline) return;

    const queue = useTabStore.getState().offlineQueue;
    if (queue.length === 0) return;
    if (isReplayingRef.current) return;

    void replayQueue(queue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  async function replayQueue(queue: OfflineAction[]) {
    isReplayingRef.current = true;
    const { setSyncing, dequeueOfflineAction } = useTabStore.getState();

    setSyncing(true);
    logger.info('offline.queue.replay.start', { count: queue.length });

    // Phase 15 Plan 04: collect actions dropped due to STALE_VERSION /
    // NOT_FOUND_VERSIONED so we can emit a single summary toast post-batch
    // (D-12, D-16 revised — no per-action prompt).
    const discarded: OfflineAction[] = [];

    for (const action of queue) {
      let dropAndAudit = false;
      try {
        const result = await dispatchAction(action);
        if (result && !result.ok) {
          const code = result.error.code;
          if (code === 'STALE_VERSION' || code === 'NOT_FOUND_VERSIONED') {
            dropAndAudit = true;
            logger.warn('offline.queue.replay.discarded_stale', {
              actionId: action.id,
              type: action.type,
              code,
              expectedVersion: action.expectedVersion,
            });
          } else {
            logger.error('offline.queue.replay.action_failed', {
              actionId: action.id,
              type: action.type,
              code,
              message: result.error.message,
            });
          }
        } else {
          logger.info('offline.queue.replay.action_ok', {
            actionId: action.id,
            type: action.type,
          });
        }
      } catch (e) {
        logger.error('offline.queue.replay.action_threw', {
          actionId: action.id,
          type: action.type,
          error: e,
        });
      } finally {
        dequeueOfflineAction(action.id);
        if (dropAndAudit) {
          discarded.push(action);
          writeDiscardAuditAsync(action);
        }
      }
    }

    if (discarded.length > 0) {
      toast.error(formatDiscardedSummary(discarded));
    }

    setSyncing(false);
    isReplayingRef.current = false;
    logger.info('offline.queue.replay.done', {
      count: queue.length,
      discarded: discarded.length,
    });
  }

  async function dispatchAction(action: OfflineAction) {
    switch (action.type) {
      case 'open-tab': {
        return openTab.mutateAsync(action.payload as Parameters<typeof openTab.mutateAsync>[0]);
      }
      case 'place-order': {
        return addOrder.mutateAsync(action.payload as Parameters<typeof addOrder.mutateAsync>[0]);
      }
      case 'start-pool-timer':
      case 'stop-pool-timer': {
        // Pool timer feature removed (Phase 1 strip-rebrand) — any queued action of
        // this type predates the removal and is silently discarded, matching the
        // default unknown-type path below.
        logger.warn('offline.queue.replay.unknown_type', { type: action.type });
        return undefined;
      }
      default: {
        logger.warn('offline.queue.replay.unknown_type', { type: action.type });
        return undefined;
      }
    }
  }

  return null;
}
