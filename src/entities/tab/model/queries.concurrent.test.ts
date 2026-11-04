/**
 * Phase 15 Plan 06 Task 1 — fast-check property test for parallel mutations.
 *
 * Proves the version contract end-to-end at the property layer:
 *   - Group A (RPC pattern, e.g. process_payment_atomic / create_order_with_items):
 *     server raises P0V01 → STALE_VERSION on expected_version mismatch.
 *   - Group B (hook-optimistic pattern, e.g. close_tab / transfer_tab / void_order):
 *     direct UPDATE with .eq('version', expected) returns 0 rows (PGRST116) on stale.
 *
 * Invariant: for any two arbitrary concurrent mutations against the same row,
 * exactly one wins. The loser surfaces STALE_VERSION; after re-reading the row
 * the loser's retry succeeds.
 *
 * fast-check import MUST precede vitest (alphabetical import/order ESLint rule —
 * see CLAUDE.md gotcha + existing pattern in offline-summary.test.ts).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  err,
  ok,
  parseSupabaseError,
  staleVersionError,
  type Result,
} from '@shared/lib/result';

// ---------------------------------------------------------------------------
// In-memory tabs store — simulates the live DB version contract.
// ---------------------------------------------------------------------------

type Row = { id: string; version: number; status: 'open' | 'closed' };
const tabs = new Map<string, Row>();

function reset(id: string, version: number, status: Row['status'] = 'open'): void {
  tabs.set(id, { id, version, status });
}

// ---------------------------------------------------------------------------
// Group A — RPC pattern simulator
// Mirrors process_payment_atomic / create_order_with_items behaviour:
//   - mismatched p_expected_version → PostgrestError { code: 'P0V01' }
//   - missing tab → PostgrestError { code: 'P0V02' }
//   - success → bump version by 1
// We feed those PostgrestErrors through parseSupabaseError to confirm the
// real client-side mapper produces STALE_VERSION / NOT_FOUND_VERSIONED.
// ---------------------------------------------------------------------------

interface PgErrorShape {
  code: string;
  message: string;
  details: string;
  hint: string;
  name: string;
}

function pgErr(code: string, message: string): PgErrorShape {
  return { code, message, details: '', hint: '', name: 'PostgrestError' };
}

async function callProcessPaymentRpc(
  tabId: string,
  pExpectedVersion: number
): Promise<Result<{ id: string; version: number }>> {
  // Synchronously read+write to ensure the contract is "exactly one wins"
  // even when Promise.all dispatches both. JS is single-threaded; these two
  // synchronous critical sections cannot interleave — that mirrors the
  // FOR UPDATE row-lock guarantee Postgres provides server-side.
  const row = tabs.get(tabId);
  if (!row) {
    const e = pgErr('P0V02', 'NOT_FOUND_VERSIONED');
    return err(parseSupabaseError(e as unknown as Parameters<typeof parseSupabaseError>[0]));
  }
  if (row.version !== pExpectedVersion) {
    const e = pgErr('P0V01', 'STALE_VERSION');
    return err(parseSupabaseError(e as unknown as Parameters<typeof parseSupabaseError>[0]));
  }
  row.version += 1;
  return ok({ id: row.id, version: row.version });
}

// ---------------------------------------------------------------------------
// Group B — Hook-optimistic UPDATE simulator
// Mirrors useMutationUpdateTabStatus / useMutationRecordTabPayment(close):
//   - UPDATE ... WHERE id=$1 AND version=$expected
//   - If 0 rows match → Supabase returns PGRST116, hook returns
//     err(staleVersionError(...)).
//   - On success bump version by 1.
// ---------------------------------------------------------------------------

async function callCloseTabUpdate(
  tabId: string,
  expected: number
): Promise<Result<{ id: string; version: number }>> {
  const row = tabs.get(tabId);
  if (!row) {
    // Mimic the .single() PGRST116 path on missing row.
    return err(staleVersionError(pgErr('PGRST116', 'No rows')));
  }
  if (row.version !== expected) {
    // .eq('version', expected) returns 0 rows → PGRST116.
    return err(staleVersionError(pgErr('PGRST116', 'No rows')));
  }
  row.version = expected + 1;
  row.status = 'closed';
  return ok({ id: row.id, version: row.version });
}

// ---------------------------------------------------------------------------
// Helpers for assertions on dual-result outcomes.
// ---------------------------------------------------------------------------

type OutcomePair = [
  Result<{ id: string; version: number }>,
  Result<{ id: string; version: number }>,
];

function assertExactlyOneStale(pair: OutcomePair): void {
  const winners = pair.filter(r => r.ok);
  const losers = pair.filter(r => !r.ok);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  const loser = losers[0];
  expect(loser).toBeDefined();
  if (loser) {
    expect(loser.error.code).toBe('STALE_VERSION');
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: parallel mutations on same tab (Phase 15 D-19 layer 1)', () => {
  it('Group A (RPC): exactly one of two concurrent process_payment calls succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 1, max: 100 }),
        async (tabId, startVersion) => {
          reset(tabId, startVersion);
          const pair = (await Promise.all([
            callProcessPaymentRpc(tabId, startVersion),
            callProcessPaymentRpc(tabId, startVersion),
          ])) as OutcomePair;
          assertExactlyOneStale(pair);

          // Winner advanced version exactly +1.
          const stored = tabs.get(tabId);
          expect(stored?.version).toBe(startVersion + 1);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Group B (hook-optimistic): exactly one of two concurrent close_tab UPDATEs succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 1, max: 100 }),
        async (tabId, startVersion) => {
          reset(tabId, startVersion);
          const pair = (await Promise.all([
            callCloseTabUpdate(tabId, startVersion),
            callCloseTabUpdate(tabId, startVersion),
          ])) as OutcomePair;
          assertExactlyOneStale(pair);

          const stored = tabs.get(tabId);
          expect(stored?.version).toBe(startVersion + 1);
          expect(stored?.status).toBe('closed');
        }
      ),
      { numRuns: 200 }
    );
  });

  it('after refetch, the losing call retries successfully (both groups)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 1, max: 100 }),
        fc.boolean(), // toggle: true → exercise Group A path, false → Group B
        async (tabId, startVersion, isGroupA) => {
          reset(tabId, startVersion);
          const call = isGroupA ? callProcessPaymentRpc : callCloseTabUpdate;

          const pair = (await Promise.all([
            call(tabId, startVersion),
            call(tabId, startVersion),
          ])) as OutcomePair;
          assertExactlyOneStale(pair);

          // Loser refetches the live version and retries.
          const fresh = tabs.get(tabId);
          expect(fresh).toBeDefined();
          if (!fresh) return;
          const retry = await call(tabId, fresh.version);
          expect(retry.ok).toBe(true);
          if (retry.ok) {
            expect(retry.data.version).toBe(startVersion + 2);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
