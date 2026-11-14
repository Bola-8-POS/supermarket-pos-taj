import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@shared/lib/i18n';
import { supabase } from '@shared/lib/supabase';

import { useReopenTab, type ReopenTabInput } from './useReopenTab';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseInput: ReopenTabInput = {
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  expectedVersion: 1,
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

describe('useReopenTab', () => {
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
    const { result } = renderHook(() => useReopenTab(), { wrapper });

    await result.current.mutateAsync(baseInput);

    expect(mockedRpc).toHaveBeenCalledWith('reopen_tab', {
      p_tab_id: baseInput.tabId,
      p_expected_version: baseInput.expectedVersion,
      p_reason: baseInput.reason,
      p_approval_id: baseInput.approvalId,
      p_approver_id: baseInput.approverId,
      p_idempotency_key: expect.any(String) as string,
    });
  });

  it('mints an idempotency key once and reuses it across retries until resetIdempotencyKey() is called', async () => {
    mockedRpc.mockResolvedValue({ data: { ok: true }, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useReopenTab(), { wrapper });

    await result.current.mutateAsync(baseInput);
    await result.current.mutateAsync(baseInput);

    const firstKey = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    const secondKey = (mockedRpc.mock.calls[1]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);

    result.current.resetIdempotencyKey();
    await result.current.mutateAsync(baseInput);
    const thirdKey = (mockedRpc.mock.calls[2]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    expect(thirdKey).not.toBe(firstKey);
  });

  it('returns AUTH_FORBIDDEN when the RPC payload reports the approval was refused', async () => {
    mockedRpc.mockResolvedValue({
      data: { ok: false, code: 'AUTH_FORBIDDEN' },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useReopenTab(), { wrapper });

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
    const { result } = renderHook(() => useReopenTab(), { wrapper });

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
    const { result } = renderHook(() => useReopenTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('SUPABASE_ERROR');
      expect(res.error.message).not.toBe('db exploded');
      expect(res.error.message).toBe(i18n.t('featOrders:reopenTab.genericError'));
    }
  });

  it('returns a translated generic message when the RPC payload reports an unrecognized code', async () => {
    mockedRpc.mockResolvedValue({
      data: { ok: false, code: 'SOME_UNKNOWN_CODE', message: 'raw payload text' },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useReopenTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('SUPABASE_ERROR');
      expect(res.error.message).not.toBe('raw payload text');
      expect(res.error.message).toBe(i18n.t('featOrders:reopenTab.genericError'));
    }
  });

  // Whole-branch review, Finding 2: reopen_tab's top-level `WHEN OTHERS`
  // catch-all wraps idempotency_begin's raised IDEMPOTENCY_MISMATCH/
  // IDEMPOTENCY_UNAUTHORIZED/IDEMPOTENCY_KEY_INVALID exceptions into
  // `{ok:false, code:'INTERNAL', message: SQLERRM}` — before this fix that
  // fell straight through to the generic SUPABASE_ERROR/genericError branch,
  // indistinguishable from any other unrecognized code. It must instead map
  // to a translated, dedicated error and reset the idempotency key ref so
  // the next attempt isn't stuck retrying with the same poisoned key.
  it('maps an INTERNAL/IDEMPOTENCY_* replay rejection to a dedicated translated error and resets the idempotency key', async () => {
    mockedRpc.mockResolvedValue({
      data: {
        ok: false,
        code: 'INTERNAL',
        message: 'IDEMPOTENCY_MISMATCH: key replayed with different arguments',
      },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useReopenTab(), { wrapper });

    await result.current.mutateAsync(baseInput);
    const firstKey = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;

    const res = await result.current.mutateAsync(baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(res.error.message).toBe(i18n.t('featOrders:reopenTab.idempotencyReplay'));
    }

    // A fresh call after the mismatch must not resend the same (poisoned) key.
    await result.current.mutateAsync(baseInput);
    const laterKey = (mockedRpc.mock.calls[2]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    expect(laterKey).not.toBe(firstKey);
  });

  it('leaves the already-mapped REOPEN_CAP_EXCEEDED message unchanged', async () => {
    mockedRpc.mockResolvedValue({
      data: { ok: false, code: 'REOPEN_CAP_EXCEEDED' },
      error: null,
    } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useReopenTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe(i18n.t('featOrders:reopenTab.capExceeded'));
    }
  });

  // Opus re-review Task 3, Important 1 (fix-pass F4): PaymentPane keeps one
  // mounted ReopenTabDialog and retargets it by tabId. Without binding the
  // key to the target tab, a reopen for tab A whose response was lost would
  // leave its key attached to the hook; a later reopen for tab B on the SAME
  // pane instance would replay that stale key instead of minting a fresh one.
  it('mints a fresh key when the target tab changes, even without an explicit reset (PaymentPane keeps ReopenTabDialog mounted across different tabs)', async () => {
    mockedRpc.mockResolvedValue({ data: { ok: true }, error: null } as never);

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(() => useReopenTab(), { wrapper });

    await result.current.mutateAsync(baseInput);
    const otherTabInput: ReopenTabInput = {
      ...baseInput,
      tabId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    };
    // No resetIdempotencyKey() call here — a different tab target on its own
    // must mint a fresh key, since ReopenTabDialog is permanently mounted and
    // only its tabId prop changes between reopens.
    await result.current.mutateAsync(otherTabInput);

    const firstKey = (mockedRpc.mock.calls[0]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    const secondKey = (mockedRpc.mock.calls[1]?.[1] as { p_idempotency_key?: string } | undefined)
      ?.p_idempotency_key;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });

  // Opus re-review Task 3, Important 1 (fix-pass F4): after a lost response
  // (the server may have committed, only the response was lost), the tab and
  // payment queries PaymentPane/ReopenTabDialog read must refresh even though
  // the outcome looks like a failure — otherwise a reopened sheet against the
  // same tab keeps showing stale status.
  it('invalidates tab/payment/audit queries even when the RPC call fails with an unmapped error', async () => {
    mockedRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'db exploded', code: '55555' },
    } as never);

    const wrapper = makeWrapper(queryClient);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useReopenTab(), { wrapper });

    const res = await result.current.mutateAsync(baseInput);

    expect(res.ok).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['tabs', 'list'] as unknown[] })
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['tabs', 'detail', baseInput.tabId] as unknown[] })
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['payments', 'list'] as unknown[] })
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['audit-logs'] as unknown[] })
    );
  });
});
