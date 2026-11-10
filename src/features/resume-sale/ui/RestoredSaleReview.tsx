import { useEffect, useState } from 'react';
import type { CartItem } from '@shared/lib/domain';
import { logger } from '@shared/lib/logger-instance';
import { useBasketConflicts } from '../model/basketConflicts';
import { BasketConflictList } from './BasketConflictList';

export type RestoredReviewStatus = 'checking' | 'blocked' | 'clear';

export interface RestoredSaleReviewProps {
  /** The restored lines still in the cart. */
  items: ReadonlyArray<CartItem>;
  /** Identifies `items` for the status report, so a stale report is never trusted. */
  reviewKey: string;
  onStatus: (reviewKey: string, status: RestoredReviewStatus) => void;
  /** Lines whose every conflict was accepted: they leave the persisted restored set. */
  onLinesResolved: (lineIds: string[]) => void;
  onRemoveLine: (lineId: string) => void;
}

/**
 * D-03 resolution. Compares the restored lines with current catalog values (never writes them into
 * the cart), lists every difference, and reports `blocked` until each is accepted or its line
 * removed. Accepted keys live in state on purpose: a reload re-checks every restored line.
 */
export function RestoredSaleReview({
  items,
  reviewKey,
  onStatus,
  onLinesResolved,
  onRemoveLine,
}: RestoredSaleReviewProps) {
  const { conflicts, loading } = useBasketConflicts(items);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());

  const pending = conflicts.filter(conflict => !accepted.has(conflict.key));
  const status: RestoredReviewStatus = loading ? 'checking' : pending.length > 0 ? 'blocked' : 'clear';

  useEffect(() => {
    onStatus(reviewKey, status);
  }, [onStatus, reviewKey, status]);

  // A line leaves the restored set once it had conflicts and none remain unaccepted.
  useEffect(() => {
    if (loading) return;
    const resolved = items
      .map(item => item.tempId)
      .filter(id => {
        const own = conflicts.filter(conflict => conflict.lineId === id);
        return own.length > 0 && own.every(conflict => accepted.has(conflict.key));
      });
    if (resolved.length > 0) onLinesResolved(resolved);
  }, [loading, items, conflicts, accepted, onLinesResolved]);

  if (loading || pending.length === 0) return null;

  return (
    <BasketConflictList
      conflicts={conflicts}
      acceptedKeys={accepted}
      onAccept={key => {
        const conflict = conflicts.find(c => c.key === key);
        if (conflict) {
          logger.info('resume.conflict.accepted', {
            lineId: conflict.lineId,
            kind: conflict.kind,
            saved: conflict.saved,
            current: conflict.current,
          });
        }
        setAccepted(previous => new Set(previous).add(key));
      }}
      onRemoveLine={onRemoveLine}
    />
  );
}
