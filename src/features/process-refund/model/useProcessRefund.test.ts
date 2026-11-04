import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCajaStore } from '@entities/caja';
import { ProcessRefundInputSchema } from '@entities/refund';
import i18n from '@shared/lib/i18n';
import { supabase } from '@shared/lib/supabase';

import {
  useProcessRefund,
  type ProcessRefundInput,
  type ProcessRefundMutationInput,
} from './useProcessRefund';

// ---------------------------------------------------------------------------
// Helpers — Supabase is globally mocked by test-setup.ts.
// ---------------------------------------------------------------------------

const baseInput: ProcessRefundInput = {
  originalPaymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  items: [
    { order_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', qty: 1, amount: 10.5, restock: true },
  ],
  reason: 'wrong_order',
};

const baseMutationInput: ProcessRefundMutationInput = {
  ...baseInput,
  approvalId: '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  approverId: '3a7c9e21-5f2b-4d81-9c3a-6e408f17b2d5',
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
// Schema-level cases (no hook needed)
// ---------------------------------------------------------------------------

describe('ProcessRefundInputSchema', () => {
  it('accepts a well-formed single-item payload', () => {
    const result = ProcessRefundInputSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
  });

  it('rejects an empty items array', () => {
    const result = ProcessRefundInputSchema.safeParse({ ...baseInput, items: [] });
    expect(result.success).toBe(false);
  });

  it('rejects qty <= 0', () => {
    const result = ProcessRefundInputSchema.safeParse({
      ...baseInput,
      items: [{ ...baseInput.items[0], qty: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects amount <= 0', () => {
    const result = ProcessRefundInputSchema.safeParse({
      ...baseInput,
      items: [{ ...baseInput.items[0], amount: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects two items sharing the same order_item_id', () => {
    const dupeItem = baseInput.items[0];
    const result = ProcessRefundInputSchema.safeParse({
      ...baseInput,
      items: [dupeItem, dupeItem],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid originalPaymentId', () => {
    const result = ProcessRefundInputSchema.safeParse({ ...baseInput, originalPaymentId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown reason', () => {
    const result = ProcessRefundInputSchema.safeParse({ ...baseInput, reason: 'not_a_real_reason' });
    expect(result.success).toBe(false);
  });

  it('preserves item order for a valid multi-item input', () => {
    const multiItemInput: ProcessRefundInput = {
      ...baseInput,
      items: [
        { order_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', qty: 1, amount: 10.5, restock: true },
        { order_item_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', qty: 2, amount: 5, restock: false },
      ],
    };
    const result = ProcessRefundInputSchema.safeParse(multiItemInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items.map((i) => i.order_item_id)).toEqual(
        multiItemInput.items.map((i) => i.order_item_id)
      );
    }
  });
});

// ---------------------------------------------------------------------------
// useProcessRefund mutationFn cases
// ---------------------------------------------------------------------------

describe('useProcessRefund', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    useCajaStore.setState({ currentCaja: null, isCajaOpen: false });
  });

  it('returns VALIDATION_ERROR and never calls the RPC on malformed input', async () => {
    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    const malformedInput = { ...baseMutationInput, items: [] } as ProcessRefundMutationInput;
    const res = await result.current.mutateAsync(malformedInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
    }
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it('calls supabase.rpc with the validated payload and returns ok on success', async () => {
    mockedRpc.mockResolvedValue({ data: 'refund-id-123', error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    const res = await result.current.mutateAsync(baseMutationInput);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toBe('refund-id-123');
    }
    expect(mockedRpc).toHaveBeenCalledWith('process_refund', {
      p_original_payment_id: baseInput.originalPaymentId,
      p_items: baseInput.items,
      p_reason: baseInput.reason,
      p_approval_id: baseMutationInput.approvalId,
      p_approver_id: baseMutationInput.approverId,
      p_caja_session_id: null,
      p_idempotency_key: expect.any(String) as string,
    });
  });

  it('mints an idempotency key once and reuses it across retries until resetIdempotencyKey() is called', async () => {
    mockedRpc.mockResolvedValue({ data: 'refund-id-123', error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    await result.current.mutateAsync(baseMutationInput);
    await result.current.mutateAsync(baseMutationInput);

    const firstKey = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    const secondKey = (mockedRpc.mock.calls[1]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);

    result.current.resetIdempotencyKey();
    await result.current.mutateAsync(baseMutationInput);
    const thirdKey = (mockedRpc.mock.calls[2]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    expect(thirdKey).not.toBe(firstKey);
  });

  it('calls supabase.rpc with the open caja session id when one is open', async () => {
    useCajaStore.setState({
      currentCaja: {
        id: 'caja-1',
        terminalId: 'POS-1',
        openedAt: new Date('2026-04-21T08:00:00.000Z'),
        closedAt: null,
        openedBy: 'staff-uuid-001',
        closedBy: null,
        openingCash: 500,
        closingCash: null,
        notes: null,
        status: 'open',
      },
      isCajaOpen: true,
    });
    mockedRpc.mockResolvedValue({ data: 'refund-id-123', error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    await result.current.mutateAsync(baseMutationInput);

    expect(mockedRpc).toHaveBeenCalledWith(
      'process_refund',
      expect.objectContaining({ p_caja_session_id: 'caja-1' })
    );
  });

  it('returns AUTH_FORBIDDEN when the RPC returns null (approval refused)', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    const res = await result.current.mutateAsync(baseMutationInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('AUTH_FORBIDDEN');
    }
  });

  it('returns CAJA_SESSION_NOT_OPEN with a translated message when the named session is not open', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: { message: 'CAJA_SESSION_NOT_OPEN', code: 'P0001' },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    const res = await result.current.mutateAsync(baseMutationInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('CAJA_SESSION_NOT_OPEN');
    }
  });

  it('mints a fresh key when the target payment changes, even without an explicit reset (RefundSheet stays mounted across different payments)', async () => {
    mockedRpc.mockResolvedValue({ data: 'refund-id-123', error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    await result.current.mutateAsync(baseMutationInput);
    const otherPaymentInput: ProcessRefundMutationInput = {
      ...baseMutationInput,
      originalPaymentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    };
    // No resetIdempotencyKey() call here — a different payment target on its
    // own must mint a fresh key, since RefundSheet is permanently mounted
    // and only its paymentId prop changes between refunds.
    await result.current.mutateAsync(otherPaymentInput);

    const firstKey = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    const secondKey = (mockedRpc.mock.calls[1]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  it('maps an IDEMPOTENCY_* replay rejection to a dedicated translated error, discards the key, and invalidates the refund queries for that payment', async () => {
    mockedRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'IDEMPOTENCY_MISMATCH: key replayed with different arguments', code: 'P0001' },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    const res = await result.current.mutateAsync(baseMutationInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(res.error.message).toBe(i18n.t('featOrders:processRefund.idempotencyReplay'));
    }
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['refunds']) as unknown[] })
    );

    const firstKey = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;

    // The key must have been discarded — a later attempt for the SAME
    // payment mints a brand-new key instead of resubmitting the poisoned one
    // (which would keep failing IDEMPOTENCY_MISMATCH forever).
    mockedRpc.mockResolvedValueOnce({ data: 'refund-id-456', error: null } as never);
    await result.current.mutateAsync(baseMutationInput);
    const retryKey = (mockedRpc.mock.calls[1]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    expect(retryKey).toBeTruthy();
    expect(retryKey).not.toBe(firstKey);
  });

  it('invalidates the refund and tab queries on a generic/unmapped error too, since a lost response may still have committed on the server (F3 fix round 1)', async () => {
    mockedRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'db exploded', code: '55555' },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useProcessRefund(), { wrapper });

    const res = await result.current.mutateAsync(baseMutationInput);

    expect(res.ok).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['refunds', 'by-payment', baseInput.originalPaymentId] as unknown[],
      })
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(['refunds', 'list']) as unknown[] })
    );
  });
});
