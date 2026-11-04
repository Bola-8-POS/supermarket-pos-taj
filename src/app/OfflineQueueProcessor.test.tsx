/* eslint-disable import/order -- vi.mock factories must precede imports */
/**
 * Tests for OfflineQueueProcessor — Phase 15 Plan 04 Task 2, extended by
 * offline-first Plan 01 Task 7 (retry + backoff + dead-letter).
 *
 * Covers:
 *   1. All actions succeed → no toast, queue empty
 *   2. STALE_VERSION → drop + summary toast '1 queued action(s)' + audit row
 *   3. NOT_FOUND_VERSIONED → also dropped (terminal failure)
 *   4. Audit RPC fired exactly once per discarded action
 *   5. (C2 fix) A NETWORK_OFFLINE result mid-pass is left untouched — no
 *      retryCount bump, no dead-letter — instead of being treated as a
 *      counted attempt
 *   6. A non-conflict failure that reaches MAX_QUEUE_ATTEMPTS moves the
 *      action to the dead-letter queue with a toast
 *   7. An action whose backoff window has not elapsed yet is skipped
 *   8. A STALE_VERSION conflict is still discarded immediately, never
 *      retried and never dead-lettered
 *   13-14. (I1) Backoff fires from a timer alone (no online event), and
 *      overlapping replay triggers still produce exactly one dispatch
 *   15. (I2, partial) A dead-lettered action stores the final `lastError`,
 *      and its audit row carries the payload plus the acting staff id
 *   16-17. (re-review fix round 1, N-I1) A repeated fetch-unreachable
 *      failure, and a LICENSE_LOCKED failure, never consume the attempt
 *      budget or dead-letter — left queued for the next trigger
 *   18-21. (re-review fix round 1, N-I2) Replay is gated on a signed-in
 *      session: Tests 18 and 20 pin the trigger-level gate itself (not just
 *      "no dispatch") by asserting `replayQueue` never even starts
 *      (`logger.info('...replay.start')` never fires) — see re-review round
 *      2's note on why the outcome-only version was vacuous — Test 19 shows
 *      a pending replay starts the moment a session appears, and Test 21
 *      shows an auth-style rejection mid-pass leaves the action queued
 *      rather than discarding it
 *   22. (re-review fix round 2, New Breakage 1) A pass that stops on an
 *      unreachable result arms its own fixed `UNREACHABLE_RETRY_MS` retry —
 *      it fires with no online event and without touching `retryCount`
 *
 * C1 (replay sends the enqueue-time version, not the cache's) and the rest
 * of C2 (a network drop mid-replay leaves exactly one queue entry) are
 * covered separately in OfflineQueueProcessor.replay-integrity.test.tsx,
 * which drives the REAL useMutationAddOrder hook + enqueueOfflineAction
 * (only supabase.rpc and connectivity are mocked) — this file mocks
 * '@entities/tab/model/queries' wholesale, which is exactly what let the
 * original C1/C2 bugs ship past all 12 tests here (see opus-review-task-7.md).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onlineStatus = { value: true };
const openTabMutation = { mutateAsync: vi.fn() };
const addOrderMutation = { mutateAsync: vi.fn() };
const supabaseRpc = vi.fn(() => Promise.resolve({ error: null }));
const supabaseGetSession = vi.fn();

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOnlineStatus: () => onlineStatus.value,
  isOnline: () => onlineStatus.value,
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => supabaseRpc(...(args as [])),
    auth: { getSession: () => supabaseGetSession() },
  },
}));

vi.mock('@entities/tab/model/queries', () => ({
  useMutationOpenTab: () => openTabMutation,
  useMutationAddOrder: () => addOrderMutation,
}));

import { toast } from 'sonner';
import { logger } from '@shared/lib/logger-instance';
import { useStaffStore } from '@entities/staff/model/store';
import { useTabStore } from '@entities/tab/model/store';
import { OfflineQueueProcessor, UNREACHABLE_RETRY_MS } from './OfflineQueueProcessor';

const toastMock = toast as unknown as { error: ReturnType<typeof vi.fn> };
const loggerMock = logger as unknown as { info: ReturnType<typeof vi.fn> };

function renderProcessor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OfflineQueueProcessor />
    </QueryClientProvider>
  );
}

function seedQueue(
  entries: Array<{
    type: 'open-tab' | 'place-order' | 'start-pool-timer' | 'stop-pool-timer';
    expectedVersion?: number;
    payload?: unknown;
    retryCount?: number;
    nextAttemptAt?: number | null;
  }>
) {
  const queue = entries.map((e, i) => ({
    id: `action-${String(i)}`,
    type: e.type,
    payload: e.payload ?? { tabId: `tab-${String(i)}` },
    expectedVersion: e.expectedVersion ?? 0,
    timestamp: Date.now(),
    retryCount: e.retryCount ?? 0,
    lastError: null,
    nextAttemptAt: e.nextAttemptAt ?? null,
  }));
  useTabStore.setState({ offlineQueue: queue });
}

beforeEach(() => {
  vi.clearAllMocks();
  onlineStatus.value = false;
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    selectedTabId: null,
    isTabDrawerOpen: false,
    offlineQueue: [],
    deadLetterQueue: [],
    isSyncing: false,
  });
  // N-I2 (re-review fix round 1): replay is gated on a signed-in session —
  // default to authenticated so Tests 1-17 (about queue mechanics, not auth
  // gating) behave exactly as before that fix. Tests 18-21 override this.
  useStaffStore.setState({ isAuthenticated: true });
  // Default success for all mutations
  openTabMutation.mutateAsync.mockResolvedValue({ ok: true, data: {} });
  addOrderMutation.mutateAsync.mockResolvedValue({ ok: true, data: {} });
  supabaseRpc.mockImplementation(() => Promise.resolve({ error: null }));
  supabaseGetSession.mockResolvedValue({ data: { session: { access_token: 'test-access-token' } } });
});

afterEach(() => {
  useTabStore.setState({ offlineQueue: [], deadLetterQueue: [] });
  useStaffStore.setState({ isAuthenticated: false });
});

async function flush() {
  // microtasks then small macrotask flush
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('OfflineQueueProcessor — replay', () => {
  it('Test 1: all 3 actions succeed → no toast, queue empty', async () => {
    seedQueue([
      { type: 'open-tab' },
      { type: 'place-order', expectedVersion: 5 },
      { type: 'start-pool-timer' },
    ]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    });
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(supabaseRpc).not.toHaveBeenCalled();
  });

  it('Test 2: 1 STALE_VERSION among 3 → drop + summary toast (1 action) + 2 succeed', async () => {
    addOrderMutation.mutateAsync.mockResolvedValueOnce({
      ok: false,
      error: { code: 'STALE_VERSION', message: 'stale' },
    });
    seedQueue([
      { type: 'open-tab' },
      { type: 'place-order', expectedVersion: 7 },
      { type: 'start-pool-timer' },
    ]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    });
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledWith(
      'Discarded 1 queued action(s) — data changed: place-order'
    );
  });

  it('Test 3: STALE_VERSION drop fires record_audit once per discard', async () => {
    addOrderMutation.mutateAsync.mockResolvedValueOnce({
      ok: false,
      error: { code: 'STALE_VERSION', message: 'stale' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 7, payload: { tabId: 'TAB-A' } }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(supabaseRpc).toHaveBeenCalledTimes(1);
    });
    expect(supabaseRpc).toHaveBeenCalledWith(
      'record_audit',
      expect.objectContaining({
        p_action: 'offline.discarded_stale',
        p_entity_type: 'tabs',
        p_entity_id: 'TAB-A',
      })
    );
  });

  it('Test 4: NOT_FOUND_VERSIONED also drops with audit + summary toast', async () => {
    addOrderMutation.mutateAsync.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND_VERSIONED', message: 'gone' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 9 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(supabaseRpc).toHaveBeenCalledTimes(1);
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      'Discarded 1 queued action(s) — data changed: place-order'
    );
  });

  it('Test 5 (C2 fix): a NETWORK_OFFLINE result mid-pass is left untouched — no retryCount bump, no dead-letter, pass stops', async () => {
    addOrderMutation.mutateAsync.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NETWORK_OFFLINE', message: 'no network' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    // A NETWORK_OFFLINE result never reached the server — it must not count
    // as an attempt (retryCount/lastError untouched) and must not be
    // dead-lettered either; it's the same entry, unchanged, waiting for the
    // next trigger.
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    expect(useTabStore.getState().offlineQueue[0]?.id).toBe('action-0');
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
    expect(useTabStore.getState().offlineQueue[0]?.lastError).toBeNull();
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(supabaseRpc).not.toHaveBeenCalled();
  });

  it('Test 6: retries a place-order action that throws instead of dropping it', async () => {
    addOrderMutation.mutateAsync.mockRejectedValueOnce(new Error('boom'));
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(addOrderMutation.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(1);
    expect(useTabStore.getState().offlineQueue[0]?.lastError).toBe('boom');
  });

  it('Test 7: moves a place-order action to the dead-letter queue after MAX_QUEUE_ATTEMPTS', async () => {
    addOrderMutation.mutateAsync.mockRejectedValue(new Error('boom'));
    seedQueue([{ type: 'place-order', expectedVersion: 1, retryCount: 4 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(useTabStore.getState().deadLetterQueue).toHaveLength(1);
    });
    expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    expect(useTabStore.getState().deadLetterQueue[0]?.id).toBe('action-0');
    expect(toastMock.error).toHaveBeenCalled();
  });

  it('Test 8: skips an action whose backoff window has not elapsed yet', async () => {
    seedQueue([
      { type: 'place-order', expectedVersion: 1, nextAttemptAt: Date.now() + 60_000 },
    ]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    expect(addOrderMutation.mutateAsync).not.toHaveBeenCalled();
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
  });

  it('Test 9: a STALE_VERSION conflict is still discarded immediately, never dead-lettered', async () => {
    addOrderMutation.mutateAsync.mockResolvedValueOnce({
      ok: false,
      error: { code: 'STALE_VERSION', message: 'stale' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    });
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
  });

  it('Test 10: an open-tab failure is dead-lettered on the first attempt (no idempotency key exists for a raw insert)', async () => {
    openTabMutation.mutateAsync.mockRejectedValueOnce(new Error('boom'));
    seedQueue([{ type: 'open-tab' }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(useTabStore.getState().deadLetterQueue).toHaveLength(1);
    });
    expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    expect(useTabStore.getState().deadLetterQueue[0]?.retryCount).toBe(0);
  });

  it('Test 11: an INVENTORY_NEGATIVE business rejection is discarded immediately, never retried or dead-lettered', async () => {
    addOrderMutation.mutateAsync.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SUPABASE_ERROR',
        message: 'INVENTORY_NEGATIVE: no unopened package available for product X',
      },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    });
    // Discarded immediately — no retry (retryCount would have incremented
    // on the surviving entry) and no dead-letter entry either.
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it('Test 12: a generic SUPABASE_ERROR with no business-rejection prefix is still treated as transient and retried', async () => {
    addOrderMutation.mutateAsync.mockResolvedValueOnce({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'upstream request timed out' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    });
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(1);
    expect(useTabStore.getState().offlineQueue[0]?.lastError).toBe('upstream request timed out');
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('Test 13 (I1): a backed-off action replays at its nextAttemptAt with no online event', async () => {
    vi.useFakeTimers();
    try {
      addOrderMutation.mutateAsync.mockResolvedValue({ ok: true, data: {} });
      onlineStatus.value = true; // already online at mount — no transition fires
      seedQueue([
        { type: 'place-order', expectedVersion: 1, retryCount: 2, nextAttemptAt: Date.now() + 5000 },
      ]);
      renderProcessor();

      // Mount fires a replay pass immediately (already online + non-empty
      // queue), but the entry's backoff hasn't elapsed — it must be skipped,
      // not dispatched.
      await vi.advanceTimersByTimeAsync(0);
      expect(addOrderMutation.mutateAsync).not.toHaveBeenCalled();

      // No online/offline event of any kind — only time passing to the
      // scheduled nextAttemptAt should trigger the retry.
      await vi.advanceTimersByTimeAsync(5000);
      expect(addOrderMutation.mutateAsync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Test 14 (I1): two overlapping replay triggers produce exactly one dispatch (single-flight guard)', async () => {
    let resolveFirst: (value: { ok: true; data: unknown }) => void = () => {};
    addOrderMutation.mutateAsync.mockImplementationOnce(
      () => new Promise(resolve => { resolveFirst = resolve; })
    );
    onlineStatus.value = true; // already online at mount — trigger #1 (mount replay)
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    const { rerender } = renderProcessor();
    await flush();
    expect(addOrderMutation.mutateAsync).toHaveBeenCalledTimes(1);

    // Trigger #2: a full offline->online transition while trigger #1's
    // dispatch is still in flight (mutateAsync hasn't resolved). The
    // single-flight guard (isReplayingRef) must swallow it.
    onlineStatus.value = false;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    expect(addOrderMutation.mutateAsync).toHaveBeenCalledTimes(1);

    resolveFirst({ ok: true, data: {} });
    await flush();
    expect(useTabStore.getState().offlineQueue).toHaveLength(0);
  });

  it('Test 15 (I2, partial): dead-letter stores the final lastError, and the audit row carries payload + staff id', async () => {
    addOrderMutation.mutateAsync.mockRejectedValue(new Error('boom'));
    seedQueue([
      {
        type: 'place-order',
        expectedVersion: 1,
        retryCount: 4,
        payload: {
          tabId: 'TAB-A',
          order: { staffId: 'STAFF-9', status: 'pending', notes: null },
          items: [],
        },
      },
    ]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(useTabStore.getState().deadLetterQueue).toHaveLength(1);
    });
    expect(useTabStore.getState().deadLetterQueue[0]?.lastError).toBe('boom');
    expect(supabaseRpc).toHaveBeenCalledWith(
      'record_audit',
      expect.objectContaining({
        p_action: 'offline.dead_lettered',
        p_user_id: 'STAFF-9',
        p_before: expect.objectContaining({
          payload: expect.objectContaining({ tabId: 'TAB-A' }),
        }),
      })
    );
  });

  it('Test 16 (N-I1): a fetch-unreachable failure survives past MAX_QUEUE_ATTEMPTS triggers with retryCount and dead-letter untouched', async () => {
    addOrderMutation.mutateAsync.mockResolvedValue({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'TypeError: Failed to fetch' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    const { rerender } = renderProcessor();
    // MAX_QUEUE_ATTEMPTS is 5 — trigger more reconnects than that.
    for (let i = 0; i < 7; i++) {
      onlineStatus.value = false;
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <OfflineQueueProcessor />
        </QueryClientProvider>
      );
      onlineStatus.value = true;
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <OfflineQueueProcessor />
        </QueryClientProvider>
      );
      await flush();
    }
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    expect(useTabStore.getState().offlineQueue[0]?.id).toBe('action-0');
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
    expect(useTabStore.getState().offlineQueue[0]?.lastError).toBeNull();
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('Test 17 (N-I1): a LICENSE_LOCKED failure behaves the same — never counted, never dead-lettered', async () => {
    // Real shape per postgrest-js's PostgrestBuilder: a client-side
    // fetch-level rejection (licenseGuardedFetch's own Error included) is
    // wrapped as `${err.name}: ${err.message}` with an empty `code`, which
    // parseSupabaseError falls through to the generic SUPABASE_ERROR code —
    // never the typed 'LICENSE_LOCKED' AppErrorCode, which is reachable only
    // via a raw (non-postgrest) fetch caller.
    addOrderMutation.mutateAsync.mockResolvedValue({
      ok: false,
      error: {
        code: 'SUPABASE_ERROR',
        message: 'Error: LICENSE_LOCKED: this terminal is not licensed — database writes are disabled',
      },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    const { rerender } = renderProcessor();
    for (let i = 0; i < 7; i++) {
      onlineStatus.value = false;
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <OfflineQueueProcessor />
        </QueryClientProvider>
      );
      onlineStatus.value = true;
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <OfflineQueueProcessor />
        </QueryClientProvider>
      );
      await flush();
    }
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
    expect(useTabStore.getState().offlineQueue[0]?.lastError).toBeNull();
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
  });

  it('Test 17b: a LICENSE_RESTRICTED failure is held too — a restricted store keeps its queued work until relicensed', async () => {
    addOrderMutation.mutateAsync.mockResolvedValue({
      ok: false,
      error: {
        code: 'SUPABASE_ERROR',
        message: "Error: LICENSE_RESTRICTED: This terminal's license must be verified before it can do this.",
      },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    const { rerender } = renderProcessor();
    for (let i = 0; i < 7; i++) {
      onlineStatus.value = false;
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <OfflineQueueProcessor />
        </QueryClientProvider>
      );
      onlineStatus.value = true;
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <OfflineQueueProcessor />
        </QueryClientProvider>
      );
      await flush();
    }
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
  });

  it.each([
    ['place-order', 'SERVER_UNREACHABLE', 'Server unreachable (HTTP 503)'],
    ['place-order', 'SUPABASE_ERROR', 'JWT expired'],
    ['place-order', 'STORE_SCHEMA_MISMATCH', 'STORE_SCHEMA_MISMATCH: server updating'],
  ] as const)(
    'Test 23 (R3A b2): %s failing with %s / "%s" is held — no attempt spent, never dead-lettered',
    async (type, code, message) => {
      addOrderMutation.mutateAsync.mockResolvedValue({ ok: false, error: { code, message } });
      seedQueue([{ type, expectedVersion: 1 }]);
      const { rerender } = renderProcessor();
      for (let i = 0; i < 7; i++) {
        onlineStatus.value = false;
        rerender(
          <QueryClientProvider client={new QueryClient()}>
            <OfflineQueueProcessor />
          </QueryClientProvider>
        );
        onlineStatus.value = true;
        rerender(
          <QueryClientProvider client={new QueryClient()}>
            <OfflineQueueProcessor />
          </QueryClientProvider>
        );
        await flush();
      }
      expect(useTabStore.getState().offlineQueue).toHaveLength(1);
      expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
      expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
      expect(toastMock.error).not.toHaveBeenCalled();
    }
  );

  it('Test 24 (R3A b2): an open-tab that gets SERVER_UNREACHABLE stays queued instead of being dead-lettered on its single attempt', async () => {
    openTabMutation.mutateAsync.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_UNREACHABLE', message: 'Server unreachable (HTTP 502)' },
    });
    seedQueue([{ type: 'open-tab', payload: { staffId: 'staff-1' } }]);
    onlineStatus.value = true;
    renderProcessor();
    await flush();
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('Test 25 (control): a deterministic SUPABASE_ERROR with a real server message is still counted', async () => {
    addOrderMutation.mutateAsync.mockResolvedValue({
      ok: false,
      error: { code: 'SUPABASE_ERROR', message: 'duplicate key value violates unique constraint' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = true;
    renderProcessor();
    await flush();
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(1);
  });

  it('Test 26 (final review 1): no auth-js session (refresh failed transiently) — the queue is held, nothing dispatched, no attempt spent', async () => {
    supabaseGetSession.mockResolvedValue({ data: { session: null } });
    addOrderMutation.mutateAsync.mockResolvedValue({
      ok: false,
      error: { code: 'AUTH_FORBIDDEN', message: 'permission denied (anon key)' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = true;
    renderProcessor();
    await flush();
    expect(addOrderMutation.mutateAsync).not.toHaveBeenCalled();
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('Test 26c (follow-up): getSession REJECTS — pass ends cleanly as "no session" (held, nothing spent, syncing cleared) and replay still works on the next pass', async () => {
    vi.useFakeTimers();
    try {
      supabaseGetSession.mockRejectedValueOnce(new Error('lock stolen'));
      addOrderMutation.mutateAsync.mockResolvedValue({ ok: true, data: {} });
      seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
      onlineStatus.value = true;
      renderProcessor();
      await vi.advanceTimersByTimeAsync(0);

      expect(addOrderMutation.mutateAsync).not.toHaveBeenCalled();
      expect(useTabStore.getState().offlineQueue).toHaveLength(1);
      expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
      expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
      expect(useTabStore.getState().isSyncing).toBe(false);

      // Default mock resolves a session again; the re-armed retry must replay.
      await vi.advanceTimersByTimeAsync(UNREACHABLE_RETRY_MS);
      expect(addOrderMutation.mutateAsync).toHaveBeenCalledTimes(1);
      expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Test 26b (control): a session is present and AUTH_FORBIDDEN is still a discarded business rejection', async () => {
    addOrderMutation.mutateAsync.mockResolvedValue({
      ok: false,
      error: { code: 'AUTH_FORBIDDEN', message: 'permission denied' },
    });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = true;
    renderProcessor();
    await flush();
    expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    expect(toastMock.error).toHaveBeenCalled();
  });

  it('Test 18 (N-I2): no session — the mount trigger gate itself prevents a pass from starting, not just from dispatching', async () => {
    // Re-review round 2 (Minor): asserting only `mutateAsync` was never
    // called is vacuous here — the per-iteration `isAuthenticated` check
    // inside `replayQueue` (Test 21's mechanism) would ALSO leave
    // `mutateAsync` uncalled even if the mount effect's own `isReady` gate
    // were reverted to `isOnline` and let a pass start. `replayQueue`'s
    // very first lines (before touching the queue at all) are
    // `setSyncing(true)` + `logger.info('offline.queue.replay.start', ...)`
    // — asserting that never fires is the one signal that distinguishes
    // "the gate stopped a pass from starting" from "a pass started and
    // immediately broke on the per-iteration check".
    useStaffStore.setState({ isAuthenticated: false });
    onlineStatus.value = true;
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    renderProcessor();
    await flush();
    expect(loggerMock.info).not.toHaveBeenCalledWith(
      'offline.queue.replay.start',
      expect.anything()
    );
    expect(addOrderMutation.mutateAsync).not.toHaveBeenCalled();
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
  });

  it('Test 19 (N-I2): no session — no dispatch on an online transition either; a pending replay starts once a session appears', async () => {
    useStaffStore.setState({ isAuthenticated: false });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    // Online, but no session — the transition must not dispatch anything.
    expect(addOrderMutation.mutateAsync).not.toHaveBeenCalled();
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);

    // A session appears (e.g. PIN login completes) while already online —
    // this alone must start a pending replay.
    useStaffStore.setState({ isAuthenticated: true });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    await waitFor(() => {
      expect(addOrderMutation.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(useTabStore.getState().offlineQueue).toHaveLength(0);
  });

  it('Test 20 (N-I2): no session — the backoff-timer trigger gate itself prevents a pass from starting, not just from dispatching', async () => {
    // Same vacuousness fix as Test 18: if the timer effect's own `isReady`
    // gate were reverted to `isOnline`, the timer would still fire and call
    // `replayQueue`, which would still leave `mutateAsync` uncalled (via the
    // per-iteration check) — asserting `replay.start` never logs is what
    // actually pins this specific gate.
    vi.useFakeTimers();
    try {
      useStaffStore.setState({ isAuthenticated: false });
      onlineStatus.value = true;
      seedQueue([
        { type: 'place-order', expectedVersion: 1, nextAttemptAt: Date.now() + 5000 },
      ]);
      renderProcessor();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(loggerMock.info).not.toHaveBeenCalledWith(
        'offline.queue.replay.start',
        expect.anything()
      );
      expect(addOrderMutation.mutateAsync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Test 21 (N-I2): an AUTH-style rejection mid-pass leaves the action queued instead of being discarded', async () => {
    // Simulates a session that dies during the RPC round trip itself (e.g. a
    // failed token refresh firing a SIGNED_OUT event): the trigger-level gate
    // and the pre-dispatch check both saw isAuthenticated === true, but by
    // the time the result comes back the local auth state has already
    // flipped, and the RPC's own response is an auth-shaped rejection rather
    // than a real business decision.
    addOrderMutation.mutateAsync.mockImplementationOnce(() => {
      useStaffStore.setState({ isAuthenticated: false });
      return Promise.resolve({
        ok: false,
        error: { code: 'AUTH_FORBIDDEN', message: 'not allowed' },
      });
    });
    useStaffStore.setState({ isAuthenticated: true });
    seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
    onlineStatus.value = false;
    const { rerender } = renderProcessor();
    onlineStatus.value = true;
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();
    expect(useTabStore.getState().offlineQueue).toHaveLength(1);
    expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
    expect(useTabStore.getState().offlineQueue[0]?.lastError).toBeNull();
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('Test 22 (re-review round 2, New Breakage 1): an unreachable failure arms a fixed-interval retry that fires with no online event, leaving retryCount untouched', async () => {
    vi.useFakeTimers();
    try {
      addOrderMutation.mutateAsync
        .mockResolvedValueOnce({
          ok: false,
          error: { code: 'SUPABASE_ERROR', message: 'TypeError: Failed to fetch' },
        })
        .mockResolvedValueOnce({ ok: true, data: {} });
      seedQueue([{ type: 'place-order', expectedVersion: 1 }]);
      // Already online at mount — the mount trigger dispatches the first
      // (unreachable) attempt with no explicit online event anywhere in
      // this test.
      onlineStatus.value = true;
      renderProcessor();
      await vi.advanceTimersByTimeAsync(0);

      expect(addOrderMutation.mutateAsync).toHaveBeenCalledTimes(1);
      expect(useTabStore.getState().offlineQueue).toHaveLength(1);
      expect(useTabStore.getState().offlineQueue[0]?.retryCount).toBe(0);
      expect(useTabStore.getState().offlineQueue[0]?.lastError).toBeNull();

      // No online/offline event — only UNREACHABLE_RETRY_MS elapsing.
      await vi.advanceTimersByTimeAsync(UNREACHABLE_RETRY_MS);

      expect(addOrderMutation.mutateAsync).toHaveBeenCalledTimes(2);
      expect(useTabStore.getState().offlineQueue).toHaveLength(0);
      expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
