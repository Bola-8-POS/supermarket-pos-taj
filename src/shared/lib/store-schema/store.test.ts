import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStoreRuntimeConfigForTests, setStoreRuntimeConfig } from '../store-mode';
import type { StoreSchemaState } from './classify';
import { guardWrite } from './guard';

const probeMock = vi.hoisted(() => vi.fn<() => Promise<StoreSchemaState>>());
vi.mock('./probe', () => ({ probeStoreSchema: probeMock }));
const onlineMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../connectivity', () => ({ isOnline: onlineMock }));

import { useStoreSchemaPolling, useStoreSchemaStore } from './store';

const BLOCK: StoreSchemaState = { kind: 'client-outdated', server: { maxVersion: '99999999999999', applied: 999 } };

beforeEach(() => {
  probeMock.mockReset();
  onlineMock.mockReturnValue(true);
  useStoreSchemaStore.setState({ state: { kind: 'unreachable' }, checkedAt: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  resetStoreRuntimeConfigForTests();
});

describe('useStoreSchemaStore', () => {
  it('blocking_survives_unreachable', async () => {
    probeMock.mockResolvedValueOnce(BLOCK).mockResolvedValueOnce({ kind: 'unreachable' });
    await useStoreSchemaStore.getState().refresh();
    await useStoreSchemaStore.getState().refresh();
    expect(useStoreSchemaStore.getState().state.kind).toBe('client-outdated');
  });

  it('ok_after_levels_agree', async () => {
    probeMock.mockResolvedValueOnce(BLOCK).mockResolvedValueOnce({ kind: 'ok' });
    await useStoreSchemaStore.getState().refresh();
    await useStoreSchemaStore.getState().refresh();
    expect(useStoreSchemaStore.getState().state.kind).toBe('ok');
  });

  it('concurrent_refresh_shares_one_request', async () => {
    probeMock.mockResolvedValue({ kind: 'ok' });
    const { refresh } = useStoreSchemaStore.getState();
    await Promise.all([refresh(), refresh(), refresh()]);
    expect(probeMock).toHaveBeenCalledTimes(1);
  });
});

describe('useStoreSchemaPolling', () => {
  it('cloud_mode_never_probes', () => {
    setStoreRuntimeConfig({ storeMode: 'cloud' });
    vi.useFakeTimers();
    renderHook(() => {
      useStoreSchemaPolling();
    });
    vi.advanceTimersByTime(120_000);
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('offline_only_polls_every_30s_then_every_5s_while_blocking', async () => {
    setStoreRuntimeConfig({ storeMode: 'offline-only' });
    vi.useFakeTimers();
    probeMock.mockResolvedValueOnce({ kind: 'ok' }).mockResolvedValue(BLOCK);
    renderHook(() => {
      useStoreSchemaPolling();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(probeMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(probeMock).toHaveBeenCalledTimes(2); // now blocking: fast interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(probeMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe('guardWrite', () => {
  it('first_write_after_boot_probes_first', async () => {
    probeMock.mockResolvedValue({ kind: 'ok' });
    await guardWrite();
    expect(probeMock).toHaveBeenCalledTimes(1);
  });

  it('write_right_after_server_update_sees_fresh_level', async () => {
    // Cached ok is stale (older than 5 s) while the server moved on: the write probes and is refused.
    useStoreSchemaStore.setState({ state: { kind: 'ok' }, checkedAt: Date.now() - 6_000 });
    probeMock.mockResolvedValue(BLOCK);
    await expect(guardWrite()).rejects.toThrow('STORE_SCHEMA_MISMATCH');
    expect(probeMock).toHaveBeenCalledTimes(1);
  });

  it('offline_browser_skips_the_probe', async () => {
    onlineMock.mockReturnValue(false);
    await guardWrite();
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('unreachable_probe_lets_the_write_through', async () => {
    probeMock.mockResolvedValue({ kind: 'unreachable' });
    await expect(guardWrite()).resolves.toBeUndefined();
  });
});
