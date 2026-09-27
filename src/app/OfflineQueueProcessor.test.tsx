/* eslint-disable import/order -- vi.mock factories must precede imports */
/**
 * Tests for OfflineQueueProcessor — Phase 15 Plan 04 Task 2.
 *
 * Covers:
 *   1. All actions succeed → no toast, queue empty
 *   2. STALE_VERSION → drop + summary toast '1 queued action(s)' + audit row
 *   3. NOT_FOUND_VERSIONED → also dropped (terminal failure)
 *   4. Other errors (NETWORK_OFFLINE) do not trigger drop/audit toast
 *   5. Audit RPC fired exactly once per discarded action
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onlineStatus = { value: true };
const openTabMutation = { mutateAsync: vi.fn() };
const addOrderMutation = { mutateAsync: vi.fn() };
const supabaseRpc = vi.fn(() => Promise.resolve({ error: null }));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@shared/lib/logger-instance', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@shared/lib/connectivity', () => ({
  useOnlineStatus: () => onlineStatus.value,
  isOnline: () => onlineStatus.value,
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => supabaseRpc(...(args as [])),
  },
}));

vi.mock('@entities/tab/model/queries', () => ({
  useMutationOpenTab: () => openTabMutation,
  useMutationAddOrder: () => addOrderMutation,
}));

import { toast } from 'sonner';
import { useTabStore } from '@entities/tab/model/store';
import { OfflineQueueProcessor } from './OfflineQueueProcessor';

const toastMock = toast as unknown as { error: ReturnType<typeof vi.fn> };

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
  }>
) {
  const queue = entries.map((e, i) => ({
    id: `action-${String(i)}`,
    type: e.type,
    payload: e.payload ?? { tabId: `tab-${String(i)}` },
    expectedVersion: e.expectedVersion ?? 0,
    timestamp: Date.now(),
    retryCount: 0,
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
    isSyncing: false,
  });
  // Default success for all mutations
  openTabMutation.mutateAsync.mockResolvedValue({ ok: true, data: {} });
  addOrderMutation.mutateAsync.mockResolvedValue({ ok: true, data: {} });
  supabaseRpc.mockImplementation(() => Promise.resolve({ error: null }));
});

afterEach(() => {
  useTabStore.setState({ offlineQueue: [] });
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

  it('Test 5: non-version errors (NETWORK_OFFLINE) do not drop/audit/toast', async () => {
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
    await waitFor(() => {
      expect(useTabStore.getState().offlineQueue).toHaveLength(0);
    });
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(supabaseRpc).not.toHaveBeenCalled();
  });
});
