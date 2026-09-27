import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { supabase } from '@shared/lib/supabase';

import { useAddItemToTab, type AddItemToTabInput } from './useAddItemToTab';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tabId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const staffId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const productId1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const productId2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const orderId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const itemId1 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const itemId2 = '11111111-1111-4111-8111-111111111111';

const baseInput: AddItemToTabInput = {
  tabId,
  staffId,
  items: [
    { productId: productId1, quantity: 2, unitPrice: 10.5 },
    { productId: productId2, quantity: 1, unitPrice: 5 },
  ],
};

const validRpcPayload = {
  order: {
    id: orderId,
    tab_id: tabId,
    staff_id: staffId,
    created_at: new Date().toISOString(),
    status: 'pending',
    notes: null,
  },
  items: [
    {
      id: itemId1,
      order_id: orderId,
      product_id: productId1,
      quantity: 2,
      unit_price: 10.5,
      modifier_ids: [],
      modifier_price_delta: 0,
      notes: null,
      product: null,
    },
    {
      id: itemId2,
      order_id: orderId,
      product_id: productId2,
      quantity: 1,
      unit_price: 5,
      modifier_ids: [],
      modifier_price_delta: 0,
      notes: null,
      product: null,
    },
  ],
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

describe('useAddItemToTab', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it('calls create_order_with_items exactly once, with one p_items entry per input item, p_status pending, and p_staff_id matching', async () => {
    mockedRpc.mockResolvedValue({ data: validRpcPayload, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useAddItemToTab(), { wrapper });

    await result.current.addItems(baseInput);

    expect(mockedRpc).toHaveBeenCalledTimes(1);
    const [rpcName, payload] = mockedRpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(rpcName).toBe('create_order_with_items');
    expect(payload['p_status']).toBe('pending');
    expect(payload['p_staff_id']).toBe(staffId);
    expect(payload['p_items']).toEqual([
      {
        product_id: productId1,
        quantity: 2,
        unit_price: 10.5,
        modifier_ids: [],
        modifier_price_delta: 0,
        notes: null,
      },
      {
        product_id: productId2,
        quantity: 1,
        unit_price: 5,
        modifier_ids: [],
        modifier_price_delta: 0,
        notes: null,
      },
    ]);
  });

  it('resolves ok:true with one items entry per input item on a valid RPC payload', async () => {
    mockedRpc.mockResolvedValue({ data: validRpcPayload, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useAddItemToTab(), { wrapper });

    const res = await result.current.addItems(baseInput);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.items).toHaveLength(baseInput.items.length);
    }
  });

  it('resolves ok:false without throwing when the RPC call rejects with an unmapped Postgres exception', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: { message: 'db exploded', code: '55555', details: '', hint: '' },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useAddItemToTab(), { wrapper });

    const res = await result.current.addItems(baseInput);

    expect(res.ok).toBe(false);
  });
});
