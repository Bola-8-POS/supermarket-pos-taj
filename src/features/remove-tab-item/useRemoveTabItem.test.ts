import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tabKeys } from '@entities/tab/model/queries';
import * as connectivity from '@shared/lib/connectivity';
import i18n from '@shared/lib/i18n';
import { supabase } from '@shared/lib/supabase';

import { useRemoveTabItem, type RemoveTabItemInput } from './useRemoveTabItem';

// ---------------------------------------------------------------------------
// Mocks — Supabase is globally mocked by test-setup.ts.
// isOnline is mocked via the module namespace.
// ---------------------------------------------------------------------------

vi.mock('@shared/lib/connectivity', () => ({
  isOnline: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseInput: RemoveTabItemInput = {
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  itemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  productId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  quantity: 1,
  reason: 'Wrong item',
};

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockedRpc = vi.mocked(supabase.rpc);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRemoveTabItem', () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = makeQueryClient();
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(connectivity.isOnline).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it('calls remove_tab_item RPC with p_item_id + p_reason, returns ok, invalidates tab queries', async () => {
    mockedRpc.mockResolvedValue({ data: { ok: true }, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useRemoveTabItem(), { wrapper });

    const res = await result.current.removeTabItem(baseInput);

    expect(res.ok).toBe(true);
    expect(mockedRpc).toHaveBeenCalledWith('remove_tab_item', {
      p_item_id: baseInput.itemId,
      p_reason: baseInput.reason,
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: tabKeys.detail(baseInput.tabId) })
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: tabKeys.lists() })
    );
  });

  it('returns SUPABASE_ERROR when the RPC call itself errors', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: { message: 'rpc failed', code: '500', details: '', hint: '' },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useRemoveTabItem(), { wrapper });

    const res = await result.current.removeTabItem(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('SUPABASE_ERROR');
      expect(res.error.message).not.toBe('rpc failed');
      expect(res.error.message).toBe(i18n.t('featOrders:removeTabItem.genericError'));
    }
  });

  it('returns NOT_FOUND when the RPC envelope reports code NOT_FOUND', async () => {
    mockedRpc.mockResolvedValue({ data: { ok: false, code: 'NOT_FOUND' }, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useRemoveTabItem(), { wrapper });

    const res = await result.current.removeTabItem(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns TAB_NOT_OPEN when the RPC envelope reports code TAB_NOT_OPEN', async () => {
    mockedRpc.mockResolvedValue({
      data: { ok: false, code: 'TAB_NOT_OPEN' },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useRemoveTabItem(), { wrapper });

    const res = await result.current.removeTabItem(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('TAB_NOT_OPEN');
    }
  });

  it('returns NETWORK_OFFLINE error without calling the RPC when offline', async () => {
    vi.mocked(connectivity.isOnline).mockReturnValue(false);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useRemoveTabItem(), { wrapper });

    const res = await result.current.removeTabItem(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NETWORK_OFFLINE');
    }
    expect(mockedRpc).not.toHaveBeenCalled();
  });
});
