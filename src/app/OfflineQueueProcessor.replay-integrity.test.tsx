/* eslint-disable import/order -- vi.mock factories must precede imports */
/**
 * C1 + C2 replay-integrity tests (offline-first Plan 01 Task 7, fix round 2).
 *
 * opus-review-task-7.md: every test in OfflineQueueProcessor.test.tsx mocks
 * '@entities/tab/model/queries' wholesale, so none of them ever runs the
 * real useMutationAddOrder mutationFn/onSuccess — which is exactly why these
 * two bugs shipped past all 12 of those tests:
 *   C1 — a replay re-read the *current* cached tab version instead of
 *        sending the version its queue entry was minted with.
 *   C2 — a NETWORK_OFFLINE result during a replay dispatch made the hook's
 *        own offline-path onSuccess enqueue a second, duplicate entry for
 *        the same logical action.
 *
 * These tests use the REAL useMutationAddOrder hook and the REAL
 * useTabStore.enqueueOfflineAction — only the network boundary
 * (supabase.rpc) and connectivity are mocked.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Two deliberately separate flags. `transitionFlag` backs useOnlineStatus()
// (what triggers OfflineQueueProcessor to start a replay pass).
// `mutationOnlineFlag` backs isOnline() (what useMutationAddOrder's
// mutationFn checks before it will dispatch). Both read navigator.onLine in
// production, but decoupling them here is the only deterministic way to
// simulate "the pass started while online, then this action's own request
// found the connection already gone" (C2) without racing real setTimeout/
// microtask ordering against a single shared flag.
const transitionFlag = { value: false };
const mutationOnlineFlag = { value: false };

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@shared/lib/connectivity', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOnlineStatus: () => transitionFlag.value,
  isOnline: () => mutationOnlineFlag.value,
}));

const supabaseRpc = vi.fn<(...args: unknown[]) => Promise<{ data: unknown; error: unknown }>>();
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => supabaseRpc(...args),
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { access_token: 'test-access-token' } } }),
    },
  },
}));

import { useStaffStore } from '@entities/staff/model/store';
import { useTabStore } from '@entities/tab/model/store';
import { tabKeys } from '@entities/tab/model/queries';
import { mockTab } from '@entities/tab/model/types';
import { ok } from '@shared/lib/result';
import { OfflineQueueProcessor } from './OfflineQueueProcessor';

function renderProcessor(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <OfflineQueueProcessor />
    </QueryClientProvider>
  );
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function placeOrderPayload(tabId: string) {
  return {
    tabId,
    order: { staffId: mockTab.staffId, status: 'pending' as const, notes: null },
    items: [
      {
        productId: '123e4567-e89b-12d3-a456-426614174003',
        quantity: 1,
        unitPrice: 100,
        modifierIds: [],
        modifierPriceDelta: 0,
        notes: null,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transitionFlag.value = false;
  mutationOnlineFlag.value = false;
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    selectedTabId: null,
    isTabDrawerOpen: false,
    offlineQueue: [],
    deadLetterQueue: [],
    isSyncing: false,
  });
  // N-I2 (re-review fix round 1): replay is now gated on a signed-in
  // session. These C1/C2 tests are about version/duplication safety, not
  // auth gating (that's covered in OfflineQueueProcessor.test.tsx), so
  // default to authenticated here.
  useStaffStore.setState({ isAuthenticated: true });
  supabaseRpc.mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  useTabStore.setState({ offlineQueue: [], deadLetterQueue: [] });
  useStaffStore.setState({ isAuthenticated: false });
});

describe('OfflineQueueProcessor — replay integrity (real hook, network mocked)', () => {
  it('C1: replay sends the version captured at enqueue time, never a fresher one read from the cache', async () => {
    const tabId = '123e4567-e89b-12d3-a456-426614174099';

    supabaseRpc.mockImplementation((name: unknown, payload?: unknown) => {
      if (name === 'create_order_with_items') {
        const p = payload as Record<string, unknown>;
        if (p['p_expected_version'] === 3) {
          // The real server: the row has since moved to version 5, so a
          // request carrying the stale version 3 is rejected.
          return Promise.resolve({ data: null, error: { code: 'P0V01', message: 'stale' } });
        }
        // Anything else (e.g. the pre-fix bug sending the cache's version 5)
        // would be accepted — proving the assertion below actually
        // distinguishes the two.
        return Promise.resolve({
          data: {
            order: {
              id: 'order-1',
              tab_id: tabId,
              staff_id: mockTab.staffId,
              created_at: new Date().toISOString(),
              status: 'pending',
              notes: null,
            },
            items: [],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null }); // record_audit
    });

    // Enqueued (via the real store action) while the tab was at version 3.
    useTabStore.getState().enqueueOfflineAction({
      type: 'place-order',
      payload: placeOrderPayload(tabId),
      expectedVersion: 3,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // By replay time another terminal's edit landed — the cache (and the
    // real server) are now at version 5.
    qc.setQueryData(tabKeys.detail(tabId), ok({ ...mockTab, id: tabId, version: 5 }));

    mutationOnlineFlag.value = true;
    const { rerender } = renderProcessor(qc);
    transitionFlag.value = true;
    rerender(
      <QueryClientProvider client={qc}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();

    await waitFor(() => {
      expect(supabaseRpc).toHaveBeenCalledWith(
        'create_order_with_items',
        expect.objectContaining({ p_expected_version: 3 })
      );
    });
    // A mismatch against the enqueue-time version must hit the server's
    // version guard and take the existing discard path — not silently
    // re-apply and dequeue as if it had succeeded.
    expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
  });

  it('C2: a network drop mid-replay leaves exactly one entry per action — no duplicate, and the rest of the pass is abandoned', async () => {
    // Real UUIDs: onMutate's optimistic OrderSchema.parse (which runs before
    // mutationFn's isOnline() check, regardless of connectivity) validates
    // tabId as a UUID.
    const tabIdA = '123e4567-e89b-12d3-a456-426614174101';
    const tabIdB = '123e4567-e89b-12d3-a456-426614174102';
    useTabStore.getState().enqueueOfflineAction({
      type: 'place-order',
      payload: placeOrderPayload(tabIdA),
      expectedVersion: 2,
    });
    useTabStore.getState().enqueueOfflineAction({
      type: 'place-order',
      payload: placeOrderPayload(tabIdB),
      expectedVersion: 0,
    });
    const originalIds = useTabStore.getState().offlineQueue.map(a => a.id);

    // The pass is triggered by an offline->online transition, but by the
    // time the first dispatch's mutationFn actually checks isOnline(), the
    // connection has already dropped again (a real flap mid-pass).
    mutationOnlineFlag.value = false;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderProcessor(qc);
    transitionFlag.value = true;
    rerender(
      <QueryClientProvider client={qc}>
        <OfflineQueueProcessor />
      </QueryClientProvider>
    );
    await flush();

    // Exactly the original two entries remain, unchanged — no duplicate was
    // created by the hook's own offline-path re-enqueue, no attempt was
    // recorded against the one that ran, and the second action was never
    // even dispatched (the pass stops at the first NETWORK_OFFLINE).
    const queue = useTabStore.getState().offlineQueue;
    expect(queue).toHaveLength(2);
    expect(queue.map(a => a.id)).toEqual(originalIds);
    expect(queue[0]?.retryCount).toBe(0);
    expect(queue[0]?.lastError).toBeNull();
    expect(queue[1]?.retryCount).toBe(0);
    expect(useTabStore.getState().deadLetterQueue).toHaveLength(0);
    expect(supabaseRpc).not.toHaveBeenCalledWith('create_order_with_items', expect.anything());
  });
});
