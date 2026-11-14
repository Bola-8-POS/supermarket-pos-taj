import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreRuntimeConfigForTests, setStoreRuntimeConfig } from '@shared/lib/store-mode';
import type * as SupabaseModule from '@shared/lib/supabase';

let backendUrl = 'https://store-pc:47304';
vi.mock('@shared/lib/supabase', async () => {
  const actual = await vi.importActual<typeof SupabaseModule>('@shared/lib/supabase');
  return { ...actual, getBackendUrl: () => backendUrl, getBackendAnonKey: () => 'anon-key-under-test' };
});

import { useStoreStatus } from './queries';

const okBody = () => new Response(JSON.stringify({ schema: 1, alerts: [{ code: 'BACKUP_STALE_72H', level: 'critical', since: 'x' }] }), { status: 200 });
const notFound = () => new Response('nope', { status: 404 });

function setup(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useStoreStatus({ enabled }), { wrapper });
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('useStoreStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setStoreRuntimeConfig({ storeMode: 'offline-only' }); // only a store-server till probes
    backendUrl = 'https://store-pc:47304';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetStoreRuntimeConfigForTests();
  });

  it('asks once and stops polling after a 404 when the server has never answered OK', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(notFound()));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = setup();
    await flush();
    expect(result.current.data?.ok).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never calls fetch for a hosted *.supabase.co backend', async () => {
    backendUrl = 'https://example-project.supabase.co';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setup();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never calls fetch in cloud mode, even for a non-supabase.co URL (e.g. local dev2)', async () => {
    setStoreRuntimeConfig({ storeMode: 'cloud' });
    backendUrl = 'http://127.0.0.1:56321';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setup();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call fetch while disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setup(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('after an OK answer keeps the last good data through failures and backs off to 5 minutes', async () => {
    const answers = [okBody, okBody, notFound, notFound, okBody];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve((answers.shift() ?? okBody)()));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = setup();
    await flush();
    expect(result.current.data?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000); // 2nd OK: normal one-minute cadence
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000); // 1st failure
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.data?.ok).toBe(true); // last good data is kept, not replaced by the error

    await vi.advanceTimersByTimeAsync(4 * 60_000); // backed off: nothing before 5 minutes
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.current.data?.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(5 * 60_000); // recovers
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000); // and is back on the one-minute cadence
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
