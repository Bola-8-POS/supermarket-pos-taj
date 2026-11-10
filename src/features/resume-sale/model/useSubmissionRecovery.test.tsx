import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCartStore } from '@entities/tab/model/cartStore';
import { err, ok } from '@shared/lib/result';
import { SUBMISSION_RECHECK_MS, SUBMISSION_SETTLE_MS } from './submissionRecovery';
import { useSavedSale } from './useSavedSale';
import { useSubmissionRecovery } from './useSubmissionRecovery';

const { lookup, cajaQuery } = vi.hoisted(() => ({
  lookup: vi.fn(),
  cajaQuery: {
    value: { isSuccess: true, isError: false, data: { id: 'caja-1', status: 'open' }, resultError: undefined },
  },
}));
vi.mock('@entities/payment', () => ({ findPaymentByIdempotencyKey: lookup }));
vi.mock('@entities/caja', () => ({
  useCurrentCaja: () => cajaQuery.value,
  useCajaStore: (selector: (s: { currentCaja: unknown }) => unknown) => selector({ currentCaja: null }),
}));

const NOW = new Date('2026-11-09T10:00:00Z').getTime();
const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
const notFound = () => Promise.resolve(ok({ status: 'not_completed' as const }));
const offline = () => err({ code: 'NETWORK_OFFLINE' as const, message: 'x' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  lookup.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useSubmissionRecovery', () => {
  it('re-queries every SUBMISSION_RECHECK_MS only while reconciling', async () => {
    lookup.mockImplementation(notFound);
    const { result } = renderHook(() => useSubmissionRecovery({ key: 'k', startedAt: NOW }), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.view.kind).toBe('reconciling');
    expect(lookup).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(SUBMISSION_RECHECK_MS));
    expect(lookup).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(SUBMISSION_RECHECK_MS));
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('stops polling once the window has passed (incomplete)', async () => {
    lookup.mockImplementation(notFound);
    const { result } = renderHook(() => useSubmissionRecovery({ key: 'k', startedAt: NOW - SUBMISSION_SETTLE_MS }), {
      wrapper,
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.view.kind).toBe('incomplete');
    await act(() => vi.advanceTimersByTimeAsync(SUBMISSION_RECHECK_MS * 3));
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry a failed lookup', async () => {
    lookup.mockResolvedValue(offline());
    const { result } = renderHook(() => useSubmissionRecovery({ key: 'k', startedAt: NOW - SUBMISSION_SETTLE_MS }), {
      wrapper,
    });
    await act(() => vi.advanceTimersByTimeAsync(SUBMISSION_RECHECK_MS * 4));
    expect(result.current.view.kind).toBe('unknown');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('retryStatusCheck while a query is in flight starts no second query', async () => {
    lookup.mockResolvedValueOnce(offline());
    const { result } = renderHook(() => useSubmissionRecovery({ key: 'k', startedAt: NOW }), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.view.kind).toBe('unknown');
    let release: (v: unknown) => void = () => undefined;
    lookup.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    act(() => {
      result.current.retryStatusCheck();
      result.current.retryStatusCheck();
    });
    expect(lookup).toHaveBeenCalledTimes(2);
    release(ok({ status: 'completed', paymentId: 'p', tabId: 't' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.view.kind).toBe('completed');
  });
});

describe('useSavedSale gate order', () => {
  it('reports recovery before resume when both a marker and checkout.open exist', () => {
    useCartStore.setState({
      items: [{ tempId: 'l1' } as never], // minimal line: the gate only counts lines
      ownerCajaSessionId: 'caja-1',
      checkout: { open: true, draft: null },
      submission: { key: 'k', startedAt: NOW },
    });
    const { result } = renderHook(() => useSavedSale(), { wrapper });
    expect(result.current.state).toBe('recovery');
    useCartStore.getState().clearCart();
  });
});
