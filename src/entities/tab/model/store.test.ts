/**
 * Tests for the `tabs` zustand persist `migrate` step — offline-first Plan 01
 * Task 7. Version bumped 2 -> 3 to add `deadLetterQueue` plus per-entry
 * `lastError` / `nextAttemptAt`; rehydrating older persisted state must not
 * throw and must backfill sensible defaults.
 */
import { describe, expect, it } from 'vitest';
import type { OfflineAction } from '@shared/lib/domain';
import { useTabStore } from './store';

function migrate(persisted: unknown, version: number): unknown {
  const fn = useTabStore.persist.getOptions().migrate;
  if (!fn) throw new Error('migrate is not configured');
  return fn(persisted, version);
}

describe('tabs store persist migration', () => {
  it('backfills lastError/nextAttemptAt on a pre-v3 offlineQueue entry and adds an empty deadLetterQueue', () => {
    const persisted = {
      activeTabId: null,
      selectedTabId: null,
      offlineQueue: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          type: 'place-order',
          payload: { tabId: 'tab-1' },
          expectedVersion: 3,
          timestamp: 1000,
          retryCount: 1,
          // no lastError / nextAttemptAt — pre-v3 shape
        },
      ],
      // no deadLetterQueue key at all — pre-v3 shape
    };

    const result = migrate(persisted, 2) as {
      offlineQueue: OfflineAction[];
      deadLetterQueue: OfflineAction[];
    };

    expect(result.deadLetterQueue).toEqual([]);
    expect(result.offlineQueue).toHaveLength(1);
    expect(result.offlineQueue[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      retryCount: 1,
      lastError: null,
      nextAttemptAt: null,
    });
  });

  it('drops pre-Phase-15 entries with a type outside the locked enum, from both queues', () => {
    const persisted = {
      offlineQueue: [{ id: 'a', type: 'close-tab', payload: null, timestamp: 1 }],
      deadLetterQueue: [{ id: 'b', type: 'transfer-tab', payload: null, timestamp: 1 }],
    };

    const result = migrate(persisted, 1) as {
      offlineQueue: OfflineAction[];
      deadLetterQueue: OfflineAction[];
    };

    expect(result.offlineQueue).toEqual([]);
    expect(result.deadLetterQueue).toEqual([]);
  });

  it('is idempotent on an already-v3-shaped payload', () => {
    const entry: OfflineAction = {
      id: '22222222-2222-4222-8222-222222222222',
      type: 'open-tab',
      payload: null,
      expectedVersion: 0,
      timestamp: 5,
      retryCount: 2,
      lastError: 'boom',
      nextAttemptAt: 12345,
    };
    const persisted = { offlineQueue: [entry], deadLetterQueue: [] };

    const result = migrate(persisted, 3) as {
      offlineQueue: OfflineAction[];
      deadLetterQueue: OfflineAction[];
    };

    expect(result.offlineQueue).toEqual([entry]);
    expect(result.deadLetterQueue).toEqual([]);
  });

  it('defaults missing offlineQueue/deadLetterQueue arrays to empty rather than throwing', () => {
    const result = migrate({ activeTabId: null }, 0) as {
      offlineQueue: OfflineAction[];
      deadLetterQueue: OfflineAction[];
    };
    expect(result.offlineQueue).toEqual([]);
    expect(result.deadLetterQueue).toEqual([]);
  });

  it('passes through non-object persisted state unchanged', () => {
    expect(migrate(null, 2)).toBeNull();
  });
});
