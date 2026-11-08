import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getProbeTarget,
  isOnline,
  isUnreachableFailure,
  probeReachability,
  setProbeTarget,
  startConnectivityMonitor,
  subscribeConnectivity,
  useOnlineStatus,
} from './connectivity';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubEnv('VITE_SUPABASE_URL', 'http://supabase.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  vi.useFakeTimers();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('probeReachability', () => {
  it('resolves true when the endpoint answers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(probeReachability()).resolves.toBe(true);
  });

  it('probes a small GET endpoint, never the PostgREST schema root and never a write', async () => {
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = spy;
    await probeReachability();
    expect(spy).toHaveBeenCalledWith(
      'http://supabase.test/auth/v1/health',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('resolves false when the endpoint rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(probeReachability()).resolves.toBe(false);
  });

  it('resolves false when the endpoint never answers within the timeout', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        })
    );
    const pending = probeReachability();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBe(false);
  });

  it('treats any HTTP response, including 401, as reachable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(probeReachability()).resolves.toBe(true);
  });
});

describe('isOnline', () => {
  it('is false when the browser reports offline, without probing', () => {
    vi.stubGlobal('navigator', { onLine: false });
    const spy = vi.fn();
    globalThis.fetch = spy;
    expect(isOnline()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('becomes false after a probe finds the backend unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const stop = startConnectivityMonitor();
    await vi.advanceTimersByTimeAsync(100);
    expect(isOnline()).toBe(false);
    stop();
  });

  it('recovers to true once a later probe succeeds', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('x'))
      .mockResolvedValue(new Response(null, { status: 200 }));
    const stop = startConnectivityMonitor();
    await vi.advanceTimersByTimeAsync(100);
    expect(isOnline()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(isOnline()).toBe(true);
    stop();
  });
});

describe('startConnectivityMonitor re-probe cadence', () => {
  it('re-probes within seconds while unreachable, so one slow probe cannot block writes for a whole interval', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('aborted'))
      .mockResolvedValue(new Response(null, { status: 200 }));
    const stop = startConnectivityMonitor();
    await vi.advanceTimersByTimeAsync(100);
    expect(isOnline()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(isOnline()).toBe(true);
    stop();
  });
});

describe('subscribeConnectivity', () => {
  it('notifies on a probe verdict change and on window offline events', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await probeReachability();
    const listener = vi.fn();
    const unsubscribe = subscribeConnectivity(listener);

    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await probeReachability();
    expect(listener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('offline'));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    window.dispatchEvent(new Event('online'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('useOnlineStatus', () => {
  it('re-renders to offline when a probe finds the backend unreachable, with no window event', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await probeReachability();
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);

    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => {
      await probeReachability();
    });
    expect(result.current).toBe(false);
  });
});

describe('getProbeTarget', () => {
  it('falls_back_to_the_build_time_env_before_the_client_exists', () => {
    expect(getProbeTarget()).toEqual({ url: 'http://supabase.test', anonKey: 'anon-key' });
  });
});

describe('getProbeTarget without any backend', () => {
  it('is_null_when_no_target_was_set_and_the_env_has_no_url', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.resetModules();
    const fresh = await import('./connectivity');
    expect(fresh.getProbeTarget()).toBeNull();
  });
});

describe('isUnreachableFailure', () => {
  it('schema_mismatch_code_is_unreachable', () => {
    expect(isUnreachableFailure('STORE_SCHEMA_MISMATCH', 'server updating')).toBe(true);
  });

  it('schema_mismatch_message_prefix_is_unreachable', () => {
    expect(isUnreachableFailure('SUPABASE_ERROR', 'Error: STORE_SCHEMA_MISMATCH: client-outdated')).toBe(true);
  });

  it('classifies transport-level failures as unreachable', () => {
    expect(isUnreachableFailure('NETWORK_OFFLINE', 'offline')).toBe(true);
    expect(isUnreachableFailure('SUPABASE_ERROR', 'TypeError: Failed to fetch')).toBe(true);
    expect(isUnreachableFailure('SUPABASE_ERROR', 'AbortError: signal is aborted')).toBe(true);
    expect(isUnreachableFailure('SUPABASE_ERROR', 'Error: LICENSE_LOCKED: terminal locked')).toBe(true);
    expect(isUnreachableFailure('SUPABASE_ERROR', 'Error: LICENSE_RESTRICTED: x')).toBe(true);
  });

  it('classifies a typed licence refusal (prefix already stripped) as unreachable', () => {
    expect(isUnreachableFailure('LICENSE_RESTRICTED', 'verify the license first')).toBe(true);
    expect(isUnreachableFailure('LICENSE_LOCKED', 'renew the license')).toBe(true);
  });

  it('classifies SERVER_UNREACHABLE and an expired JWT as unreachable (hold, never fail)', () => {
    expect(isUnreachableFailure('SERVER_UNREACHABLE', 'Server unreachable (HTTP 503)')).toBe(true);
    expect(isUnreachableFailure('SUPABASE_ERROR', 'JWT expired')).toBe(true);
  });

  it('classifies the store-switch fence refusals as unreachable, by code or by message', () => {
    expect(isUnreachableFailure('STORE_FROZEN', 'x')).toBe(true);
    expect(isUnreachableFailure('STORE_MOVED', 'x')).toBe(true);
    expect(isUnreachableFailure('SUPABASE_ERROR', 'Error: STORE_MOVED: pair this till')).toBe(true);
    expect(isUnreachableFailure('SUPABASE_ERROR', 'DIRECT_SALE_FAILED: STORE_FROZEN: moving')).toBe(true);
    // a code quoted mid-message (a product name) is not a refusal
    expect(isUnreachableFailure('SUPABASE_ERROR', 'INVENTORY_NEGATIVE: not enough stock for STORE_FROZEN: Chili')).toBe(false);
    // a 40001 serialization failure is never one of them (it is not an attempt either way; no retry is added)
    expect(isUnreachableFailure('SUPABASE_ERROR', 'could not serialize access due to concurrent update')).toBe(false);
  });

  it('does not classify a server answer as unreachable', () => {
    expect(isUnreachableFailure('AUTH_FORBIDDEN', 'permission denied for table products')).toBe(false);
    expect(isUnreachableFailure('SUPABASE_ERROR', 'duplicate key value')).toBe(false);
  });
});

// Last in the file: setProbeTarget is module state and outlives this test.
describe('setProbeTarget', () => {
  it('probes the backend the Supabase client was initialised with (runtime override), not the build-time env', async () => {
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = spy;
    setProbeTarget('http://runtime.test', 'runtime-key');
    await probeReachability();
    expect(spy).toHaveBeenCalledWith(
      'http://runtime.test/auth/v1/health',
      expect.objectContaining({ headers: { apikey: 'runtime-key' } })
    );
  });
});
