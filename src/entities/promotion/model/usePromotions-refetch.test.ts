import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Connectivity from '@shared/lib/connectivity';
import { ok } from '@shared/lib/result';
import { createTestQueryClient } from '@shared/lib/test-utils';

const { fetchAllRows, isOnline } = vi.hoisted(() => ({ fetchAllRows: vi.fn(), isOnline: vi.fn() }));
vi.mock('@shared/lib/fetch-all-rows', () => ({ fetchAllRows }));
vi.mock('@shared/lib/connectivity', async (orig) => ({
  ...(await orig<typeof Connectivity>()),
  isOnline,
}));

import { usePromotions } from './queries';

function mountWithPersistedCache() {
  const client = createTestQueryClient();
  // what a restored (persisted) cache looks like: data from a previous page load, before the promotion was deleted
  client.setQueryData(['promotions'], ok([{ id: 'deleted-promo' }]), { updatedAt: Date.now() - 60_000 });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(() => usePromotions(), { wrapper });
}

describe('usePromotions mount refetch', () => {
  beforeEach(() => {
    fetchAllRows.mockReset().mockResolvedValue(ok([]));
    isOnline.mockReset();
  });

  it('refetches on mount when online, even though the restored data is within staleTime', async () => {
    isOnline.mockReturnValue(true);
    mountWithPersistedCache();
    await waitFor(() => {
      expect(fetchAllRows).toHaveBeenCalled();
    });
  });

  it('serves the persisted cache without fetching when offline', async () => {
    isOnline.mockReturnValue(false);
    const { result } = mountWithPersistedCache();
    expect(result.current.data).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchAllRows).not.toHaveBeenCalled();
  });
});
