/**
 * Unit tests for useReceiveShipment's idempotency-key behavior (wave 3a,
 * Task 2): one crypto.randomUUID() per submission attempt, reused across a
 * retry of that same attempt, cleared only once the attempt actually
 * succeeds.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiveShipmentRequest } from '@shared/lib/edge-function-contracts';
import { err, ok } from '@shared/lib/result';
import { useReceiveShipment } from './useReceiveShipment';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCallReceiveShipment = vi.fn();
vi.mock('@shared/lib/edge-function-contracts', () => ({
  callReceiveShipment: (request: unknown) =>
    (mockCallReceiveShipment as (r: unknown) => unknown)(request),
}));

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const baseRequest: ReceiveShipmentRequest = {
  supplierId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  items: [{ productId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', quantity: 1, costPrice: 10 }],
};

function keyOf(callIndex: number): string | undefined {
  const call = mockCallReceiveShipment.mock.calls[callIndex] as [{ idempotencyKey?: string }];
  return call[0].idempotencyKey;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useReceiveShipment', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it('reuses the same idempotencyKey across a retry, then issues a fresh one after success', async () => {
    mockCallReceiveShipment
      .mockResolvedValueOnce(err({ code: 'SUPABASE_ERROR', message: 'network blip' }))
      .mockResolvedValueOnce(ok({ shipmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }))
      .mockResolvedValueOnce(ok({ shipmentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }));

    const { result } = renderHook(() => useReceiveShipment(), {
      wrapper: makeWrapper(queryClient),
    });

    // Attempt 1, first try: fails, key is generated and kept.
    await result.current.mutateAsync(baseRequest);
    expect(mockCallReceiveShipment).toHaveBeenCalledTimes(1);
    const firstKey = keyOf(0);
    expect(firstKey).toBeTruthy();

    // Attempt 1, retry: same key, this time it succeeds.
    await result.current.mutateAsync(baseRequest);
    expect(mockCallReceiveShipment).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(firstKey);

    // Attempt 2, a fresh submission after success: a new key.
    await result.current.mutateAsync(baseRequest);
    expect(mockCallReceiveShipment).toHaveBeenCalledTimes(3);
    expect(keyOf(2)).toBeTruthy();
    expect(keyOf(2)).not.toBe(firstKey);
  });

  it('regenerates the key when the request changes after a failed attempt, keeps it when unchanged', async () => {
    mockCallReceiveShipment
      .mockResolvedValueOnce(err({ code: 'SUPABASE_ERROR', message: 'network blip' }))
      .mockResolvedValueOnce(err({ code: 'SUPABASE_ERROR', message: 'network blip' }))
      .mockResolvedValueOnce(ok({ shipmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }));

    const { result } = renderHook(() => useReceiveShipment(), {
      wrapper: makeWrapper(queryClient),
    });

    // Attempt 1 fails; a key is generated. A failure alone never clears it —
    // the failed response may have actually committed on the server.
    await result.current.mutateAsync(baseRequest);
    const firstKey = keyOf(0);
    expect(firstKey).toBeTruthy();

    // The exact same request resubmitted (an ordinary retry): same key, so
    // a committed-but-lost first attempt replays instead of double-receiving.
    await result.current.mutateAsync(baseRequest);
    expect(keyOf(1)).toBe(firstKey);

    // The user edits a line before resubmitting: a new key. Without this,
    // a lost response from the failed attempt above would let the edited
    // submission silently replay the earlier, edited-away one instead of
    // sending the edit.
    const editedRequest: ReceiveShipmentRequest = {
      ...baseRequest,
      items: [{ ...baseRequest.items[0]!, quantity: 2 }],
    };
    await result.current.mutateAsync(editedRequest);
    expect(mockCallReceiveShipment).toHaveBeenCalledTimes(3);
    expect(keyOf(2)).toBeTruthy();
    expect(keyOf(2)).not.toBe(firstKey);
  });
});
