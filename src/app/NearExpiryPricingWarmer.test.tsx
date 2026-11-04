/* eslint-disable i18next/no-literal-string -- test fixture data, not UI copy. */
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inventoryKeys, useNearExpiryPricingDates } from '@entities/inventory';
import { evaluateOfflineEligibility } from '@entities/offline-sale';
import { useStaffStore } from '@entities/staff/model/store';
import { ok } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { createTestQueryClient } from '@shared/lib/test-utils';
import { NearExpiryPricingWarmer } from './NearExpiryPricingWarmer';

const settingsState = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@entities/settings', () => ({ useSettings: () => ({ data: settingsState.value }) }));

// eslint-disable-next-line @typescript-eslint/unbound-method -- vi.mock'd supabase method
const mockedFrom = vi.mocked(supabase).from;
const withThreshold = (thresholdDays: number) => ({ nearExpiry: { thresholdDays, discountPercent: 15 } });
const day = (plus: number) =>
  new Date(Date.now() + plus * 86_400_000).toISOString().slice(0, 10);

/** The query now ends in .order().range() and carries a count; `lte` stays the spy for its args and results. */
const paged = (lte: (...a: unknown[]) => unknown) =>
  (...a: unknown[]) => ({
    order: () => ({
      range: async () => {
        const r = (await lte(...a)) as { data: unknown; error: unknown };
        return { count: Array.isArray(r.data) ? r.data.length : null, ...r };
      },
    }),
  });

function lteMock() {
  const lte = vi.fn().mockResolvedValue({ data: [], error: null });
  mockedFrom.mockImplementation(
    () => ({ select: () => ({ not: () => ({ lte: paged(lte) }) }) }) as unknown as ReturnType<typeof supabase.from>
  );
  return lte;
}
const wrapperFor = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };

describe('NearExpiryPricingWarmer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStaffStore.setState({ isAuthenticated: true });
    settingsState.value = withThreshold(14);
  });

  it('the pricing list for the current threshold is fetched at start-up without the checkout mounted', async () => {
    const lte = lteMock();
    render(createElement(NearExpiryPricingWarmer), { wrapper: wrapperFor(createTestQueryClient()) });

    await waitFor(() => { expect(lte).toHaveBeenCalledTimes(1); });
    expect(lte.mock.calls[0]?.[1]).toBe(day(14 + 8));
  });

  it('saving a new near-expiry threshold prefetches the pricing list for it', async () => {
    const lte = lteMock();
    const { rerender } = render(createElement(NearExpiryPricingWarmer), {
      wrapper: wrapperFor(createTestQueryClient()),
    });
    await waitFor(() => { expect(lte).toHaveBeenCalledTimes(1); });

    // the settings save invalidates the settings query; the refetched snapshot carries the new threshold
    settingsState.value = withThreshold(40);
    rerender(createElement(NearExpiryPricingWarmer));

    await waitFor(() => { expect(lte).toHaveBeenCalledTimes(2); });
    expect(lte.mock.calls[1]?.[1]).toBe(day(40 + 8));
  });

  it('does not fetch for a signed-out session', async () => {
    const lte = lteMock();
    useStaffStore.setState({ isAuthenticated: false });
    render(createElement(NearExpiryPricingWarmer), { wrapper: wrapperFor(createTestQueryClient()) });
    await new Promise(r => setTimeout(r, 20));
    expect(lte).not.toHaveBeenCalled();
  });

  it('after a threshold change and prefetch, an offline sale is not refused for revalidation', async () => {
    lteMock();
    const qc = createTestQueryClient();
    settingsState.value = withThreshold(40);
    render(createElement(NearExpiryPricingWarmer), { wrapper: wrapperFor(qc) });
    await waitFor(() => { expect(qc.getQueryData(['inventory', 'near-expiry-pricing', 40])).toBeDefined(); });

    onlineManager.setOnline(false); // the backend drops before /pos is opened
    try {
      const { result } = renderHook(() => useNearExpiryPricingDates(), { wrapper: wrapperFor(qc) });
      expect(result.current.data).toEqual([]);
      expect(
        evaluateOfflineEligibility({
          method: 'cash',
          legs: undefined,
          referenceNumber: undefined,
          hasDiscount: false,
          hasOverride: false,
          licenseState: 'active',
          requiresRevalidation: result.current.data === undefined,
          isCajaOpen: true,
          limit: { ok: true },
        })
      ).toEqual({ ok: true });
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('the warmer retries after a failed fetch', async () => {
    const lte = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'fetch failed', code: 'PGRST000' } })
      .mockResolvedValue({ data: [], error: null });
    mockedFrom.mockImplementation(
      () => ({ select: () => ({ not: () => ({ lte: paged(lte) }) }) }) as unknown as ReturnType<typeof supabase.from>
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 1 } } });
    render(createElement(NearExpiryPricingWarmer), { wrapper: wrapperFor(qc) });

    await waitFor(() => { expect(lte).toHaveBeenCalledTimes(2); });
    await waitFor(() => {
      expect(qc.getQueryData(inventoryKeys.nearExpiryPricing(14))).toEqual(ok([]));
    });
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('the pricing list is not collected while the session is signed in', async () => {
      lteMock();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 24 * 3_600_000 } } });
      render(createElement(NearExpiryPricingWarmer), { wrapper: wrapperFor(qc) });
      await waitFor(() => { expect(qc.getQueryData(inventoryKeys.nearExpiryPricing(14))).toBeDefined(); });

      await vi.advanceTimersByTimeAsync(25 * 3_600_000);

      expect(qc.getQueryData(inventoryKeys.nearExpiryPricing(14))).toBeDefined();
    });
  });

  it('an unknown threshold never yields a pricing list', async () => {
    const lte = lteMock();
    settingsState.value = undefined;
    const qc = createTestQueryClient();
    // a list cached for threshold 0 (e.g. an old setting) must not stand in for the unknown threshold
    qc.setQueryData(inventoryKeys.nearExpiryPricing(0), ok([]));

    const { result } = renderHook(() => useNearExpiryPricingDates(), { wrapper: wrapperFor(qc) });
    await new Promise(r => setTimeout(r, 20));

    expect(result.current.data).toBeUndefined();
    expect(lte).not.toHaveBeenCalled();
  });
});
