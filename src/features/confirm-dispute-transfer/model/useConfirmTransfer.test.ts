import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { supabase } from '@shared/lib/supabase';

import { useConfirmTransfer, type ConfirmTransferInput } from './useConfirmTransfer';

// ---------------------------------------------------------------------------
// Helpers — Supabase is globally mocked by test-setup.ts.
// ---------------------------------------------------------------------------

const baseInput: ConfirmTransferInput = {
  paymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  enteredCode: '1234567',
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
// useConfirmTransfer mutationFn cases
// ---------------------------------------------------------------------------

describe('useConfirmTransfer', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it('calls supabase.rpc with the validated payload and returns ok(true) on success', async () => {
    mockedRpc.mockResolvedValue({ data: { ok: true }, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useConfirmTransfer(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toBe(true);
    }
    expect(mockedRpc).toHaveBeenCalledWith('confirm_transfer_payment', {
      p_payment_id: baseInput.paymentId,
      p_entered_code: baseInput.enteredCode,
    });
  });

  it('maps an AUTH_FORBIDDEN RPC error to a typed AppError', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: { message: 'AUTH_FORBIDDEN: manager or admin role required', code: 'P0001', details: '', hint: '' },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useConfirmTransfer(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('AUTH_FORBIDDEN');
    }
  });

  it('maps a VALIDATION_ERROR RPC error to a typed AppError', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: {
        message: 'VALIDATION_ERROR: entered code fails check-digit validation',
        code: 'P0001',
        details: '',
        hint: '',
      },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useConfirmTransfer(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('maps a PAYMENT_ALREADY_PROCESSED RPC error to a typed AppError', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: {
        message: 'PAYMENT_ALREADY_PROCESSED: transfer already confirmed',
        code: 'P0001',
        details: '',
        hint: '',
      },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useConfirmTransfer(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('PAYMENT_ALREADY_PROCESSED');
    }
  });
});
