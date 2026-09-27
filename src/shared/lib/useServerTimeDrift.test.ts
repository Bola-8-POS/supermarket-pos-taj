/**
 * Unit tests for useServerTimeDrift hook.
 *
 * AC-3: isDrifting=true when |drift| > 120s
 * AC-4: isDrifting=false and driftSeconds=null on network error (fail silently)
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as edgeContracts from './edge-function-contracts';
import { useServerTimeDrift } from './useServerTimeDrift';

vi.mock('./edge-function-contracts', () => ({
  callGetServerTime: vi.fn(),
}));

const mockedCallGetServerTime = vi.mocked(edgeContracts.callGetServerTime);

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: Infinity,
      },
    },
  });
}

describe('useServerTimeDrift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isDrifting=true when server time is 125s in the future (AC-3)', async () => {
    const sampledAt = Date.now();
    const serverTime = new Date(sampledAt + 125_000).toISOString();

    mockedCallGetServerTime.mockImplementation(async () => {
      return { ok: true as const, data: { serverTime } };
    });

    const qc = makeQueryClient();
    const { result } = renderHook(() => useServerTimeDrift(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.isDrifting).toBe(true);
    });

    expect(result.current.driftSeconds).toBeGreaterThan(120);
  });

  it('isDrifting=true when server time is 125s in the past (AC-3)', async () => {
    const sampledAt = Date.now();
    const serverTime = new Date(sampledAt - 125_000).toISOString();

    mockedCallGetServerTime.mockImplementation(async () => {
      return { ok: true as const, data: { serverTime } };
    });

    const qc = makeQueryClient();
    const { result } = renderHook(() => useServerTimeDrift(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      expect(result.current.isDrifting).toBe(true);
    });

    expect(result.current.driftSeconds).toBeGreaterThan(120);
  });

  it('isDrifting=false when server time is within 60s (AC-3)', async () => {
    const sampledAt = Date.now();
    const serverTime = new Date(sampledAt + 30_000).toISOString();

    mockedCallGetServerTime.mockImplementation(async () => {
      return { ok: true as const, data: { serverTime } };
    });

    const qc = makeQueryClient();
    const { result } = renderHook(() => useServerTimeDrift(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      // query resolves; data is present so driftSeconds is not null
      expect(result.current.driftSeconds).not.toBeNull();
    });

    expect(result.current.isDrifting).toBe(false);
    expect(result.current.driftSeconds).toBeLessThanOrEqual(120);
  });

  it('isDrifting=false and driftSeconds=null when callGetServerTime returns Err (AC-4)', async () => {
    mockedCallGetServerTime.mockResolvedValue({
      ok: false as const,
      error: {
        code: 'NETWORK_OFFLINE' as const,
        message: 'Network error',
      },
    });

    const qc = makeQueryClient();
    const { result } = renderHook(() => useServerTimeDrift(), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => {
      // The query resolves with null (no throw) — hook returns the silent-fail state
      expect(mockedCallGetServerTime).toHaveBeenCalled();
    });

    // Wait one more tick for the query data to propagate
    await waitFor(() => {
      // isDrifting must be false regardless of network error
      expect(result.current.isDrifting).toBe(false);
    });

    expect(result.current.driftSeconds).toBeNull();
  });
});
