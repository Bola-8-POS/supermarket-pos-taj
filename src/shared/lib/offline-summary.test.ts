/**
 * Tests for formatDiscardedSummary — Phase 15 Plan 04 Task 1.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { OfflineAction, OfflineActionType } from './domain';
import { formatDiscardedSummary } from './offline-summary';

const actionTypeArb = fc.constantFrom<OfflineActionType>(
  'open-tab',
  'place-order',
  'start-pool-timer',
  'stop-pool-timer'
);

const actionArb = fc.record({
  id: fc.uuid(),
  type: actionTypeArb,
  payload: fc.constant(null),
  expectedVersion: fc.integer({ min: 0, max: 9999 }),
  timestamp: fc.integer({ min: 0, max: Date.now() }),
  retryCount: fc.integer({ min: 0, max: 5 }),
}) as unknown as fc.Arbitrary<OfflineAction>;

describe('formatDiscardedSummary', () => {
  it('Test 5: returns empty string for empty list', () => {
    expect(formatDiscardedSummary([])).toBe('');
  });

  it('Test 6 property: matches expected format for N>=1 actions', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 12 }), actions => {
        const out = formatDiscardedSummary(actions);
        expect(out).toMatch(/^Discarded \d+ queued action\(s\) — data changed: .+$/);
        expect(out).toContain(actions.length.toString());
      })
    );
  });

  it('lists each action type joined by comma+space', () => {
    const actions = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'open-tab',
        payload: null,
        expectedVersion: 0,
        timestamp: 1,
        retryCount: 0,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'place-order',
        payload: null,
        expectedVersion: 3,
        timestamp: 2,
        retryCount: 0,
      },
    ] as OfflineAction[];
    expect(formatDiscardedSummary(actions)).toBe(
      'Discarded 2 queued action(s) — data changed: open-tab, place-order'
    );
  });
});
