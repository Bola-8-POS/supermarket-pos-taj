import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@shared/lib/i18n';
import { supabase } from '@shared/lib/supabase';

import { useEditPaidTab, type EditPaidTabInput } from './useEditPaidTab';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseInput: EditPaidTabInput = {
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  expectedVersion: 1,
  orderItemPatches: [],
  notes: undefined,
  reason: 'Customer requested correction',
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
// Tests
// ---------------------------------------------------------------------------

describe('useEditPaidTab', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
  });

  it('calls supabase.rpc with the approval ticket and approver id', async () => {
    mockedRpc.mockResolvedValue({ data: { ok: true }, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useEditPaidTab(), { wrapper });

    await result.current.mutateAsync(baseInput);

    expect(mockedRpc).toHaveBeenCalledWith('edit_paid_tab', {
      p_tab_id: baseInput.tabId,
      p_expected_version: baseInput.expectedVersion,
      p_order_item_patches: baseInput.orderItemPatches,
      p_notes: baseInput.notes ?? '',
      p_reason: baseInput.reason,
      p_approval_id: baseInput.approvalId,
      p_approver_id: baseInput.approverId,
    });
  });

  it('returns AUTH_FORBIDDEN when the RPC payload reports the approval was refused', async () => {
    mockedRpc.mockResolvedValue({
      data: { ok: false, code: 'AUTH_FORBIDDEN' },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useEditPaidTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('AUTH_FORBIDDEN');
    }
  });

  it('returns AUTH_FORBIDDEN with the wait time when the caller\'s attempt budget is locked', async () => {
    mockedRpc.mockResolvedValue({
      data: { ok: false, code: 'PIN_LOCKED', retryAfter: 30 },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useEditPaidTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('AUTH_FORBIDDEN');
      expect(res.error.message).toContain('30');
    }
  });

  it('returns a translated generic message when the RPC call itself throws an unmapped Postgres exception', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: { message: 'db exploded', code: '55555', details: '', hint: '' },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useEditPaidTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('SUPABASE_ERROR');
      expect(res.error.message).not.toBe('db exploded');
      expect(res.error.message).toBe(i18n.t('featOrders:editPaidTab.genericError'));
    }
  });

  it('returns a translated generic message when the RPC payload reports an unrecognized code', async () => {
    mockedRpc.mockResolvedValue({
      data: { ok: false, code: 'SOME_UNKNOWN_CODE', message: 'raw payload text' },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useEditPaidTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('SUPABASE_ERROR');
      expect(res.error.message).not.toBe('raw payload text');
      expect(res.error.message).toBe(i18n.t('featOrders:editPaidTab.genericError'));
    }
  });

  it('leaves the already-mapped TAB_NOT_EDITABLE message unchanged', async () => {
    mockedRpc.mockResolvedValue({
      data: { ok: false, code: 'TAB_NOT_EDITABLE' },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useEditPaidTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe(i18n.t('featOrders:editPaidTab.notEditable'));
    }
  });
});
