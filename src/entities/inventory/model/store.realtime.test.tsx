/* eslint-disable @typescript-eslint/unbound-method -- asserting on vi.fn() mocks of supabase methods */
// src/entities/inventory/model/store.realtime.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreRuntimeConfigForTests, setStoreRuntimeConfig } from '@shared/lib/store-mode';
import { supabase } from '@shared/lib/supabase';
import { inventoryKeys, useInventoryAlerts } from './queries';
import { useInventoryRealtimeBridge } from './store';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('inventory Realtime and polling by store mode', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(supabase.channel).mockClear();
    vi.mocked(supabase.removeChannel).mockClear();
    resetStoreRuntimeConfigForTests();
  });
  afterEach(() => {
    client.clear();
    resetStoreRuntimeConfigForTests();
  });

  it('subscribes in cloud mode and unsubscribes on unmount', () => {
    setStoreRuntimeConfig({ storeMode: 'cloud' });
    const { unmount } = renderHook(
      () => {
        useInventoryRealtimeBridge();
      },
      { wrapper: wrapperFor(client) }
    );
    expect(supabase.channel).toHaveBeenCalledWith('inventory:changes');
    unmount();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('opens no subscription at all in Offline only', () => {
    setStoreRuntimeConfig({ storeMode: 'offline-only' });
    const { unmount } = renderHook(
      () => {
        useInventoryRealtimeBridge();
      },
      { wrapper: wrapperFor(client) }
    );
    expect(supabase.channel).not.toHaveBeenCalled();
    unmount();
    expect(supabase.removeChannel).not.toHaveBeenCalled();
  });

  it('polls the alerts every 30 s in Offline only and never in cloud mode', () => {
    const refetchInterval = () =>
      client.getQueryCache().find({ queryKey: inventoryKeys.alerts() })?.observers[0]?.options.refetchInterval;

    setStoreRuntimeConfig({ storeMode: 'cloud' });
    const cloud = renderHook(
      () => {
        useInventoryAlerts();
      },
      { wrapper: wrapperFor(client) }
    );
    expect(refetchInterval()).toBe(false);
    cloud.unmount();
    client.clear();

    setStoreRuntimeConfig({ storeMode: 'offline-only' });
    renderHook(
      () => {
        useInventoryAlerts();
      },
      { wrapper: wrapperFor(client) }
    );
    expect(refetchInterval()).toBe(30_000);
  });
});
