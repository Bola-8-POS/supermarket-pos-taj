/**
 * Offline-summary helper — Phase 15 Plan 04.
 *
 * Formats a single user-facing summary string after the OfflineQueueProcessor
 * replay batch drops one or more queued actions due to STALE_VERSION /
 * NOT_FOUND_VERSIONED conflicts (D-11, D-12, D-16 revised).
 */

import type { OfflineAction } from './domain';

export const formatDiscardedSummary = (actions: readonly OfflineAction[]): string => {
  if (actions.length === 0) return '';
  const types = actions.map(a => a.type).join(', ');
  return `Discarded ${actions.length.toString()} queued action(s) — data changed: ${types}`;
};
