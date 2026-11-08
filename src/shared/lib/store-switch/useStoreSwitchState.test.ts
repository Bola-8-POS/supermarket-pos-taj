import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchState = vi.fn();
vi.mock('./client', () => ({
  fetchStoreSwitchState: () => fetchState(),
  backendKey: () => 'backend-a',
}));

import { resetStoreRuntimeConfigForTests, setStoreRuntimeConfig } from '../store-mode';
import type { StoreSchemaState } from '../store-schema/classify';
import { useStoreSchemaStore } from '../store-schema/store';
import { readMovedFlag, useStoreSwitchStore } from './store';
import {
  applyObserved,
  POLL_ACTIVE_MS,
  POLL_BUSY_MS,
  useStoreSwitchState,
} from './useStoreSwitchState';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useStoreSwitchStore.setState({ state: 'active' });
  fetchState.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('applyObserved', () => {
  it('an unknown answer never changes what the till knows', () => {
    useStoreSwitchStore.setState({ state: 'moved' });
    applyObserved(null, 'backend-a');
    expect(useStoreSwitchStore.getState().state).toBe('moved');
  });

  it('moved is remembered across restarts and released when the cloud says active again', () => {
    applyObserved('moved', 'backend-a');
    expect(readMovedFlag('backend-a')).toBe(true);
    applyObserved('active', 'backend-a');
    expect(readMovedFlag('backend-a')).toBe(false);
  });
});

describe('applyObserved resets the cached schema status when the till leaves a moved store', () => {
  const stale: StoreSchemaState = { kind: 'client-outdated', server: { maxVersion: '9', applied: 9 } };
  const initial = useStoreSchemaStore.getInitialState();

  it('moved -> active puts the schema store back to its initial state', () => {
    useStoreSchemaStore.setState({ state: stale, checkedAt: 123 });
    useStoreSwitchStore.setState({ state: 'moved' });
    applyObserved('active', 'backend-a');
    expect(useStoreSchemaStore.getState().state).toEqual(initial.state);
    expect(useStoreSchemaStore.getState().checkedAt).toBe(0);
  });

  it('active -> active and moved -> moved leave it alone', () => {
    useStoreSchemaStore.setState({ state: stale, checkedAt: 123 });
    applyObserved('active', 'backend-a');
    useStoreSwitchStore.setState({ state: 'moved' });
    applyObserved('moved', 'backend-a');
    expect(useStoreSchemaStore.getState().state).toEqual(stale);
  });
});

describe('applyObserved reset on any exit from moved', () => {
  const stale: StoreSchemaState = { kind: 'client-outdated', server: { maxVersion: '9', applied: 9 } };
  const initial = useStoreSchemaStore.getInitialState();

  it.each(['draining', 'frozen'] as const)('moved -> %s resets the schema store', next => {
    useStoreSchemaStore.setState({ state: stale, checkedAt: 123 });
    useStoreSwitchStore.setState({ state: 'moved' });
    applyObserved(next, 'backend-a');
    expect(useStoreSchemaStore.getState().state).toEqual(initial.state);
  });

  it('in offline-only mode the reset is followed by an immediate probe', () => {
    setStoreRuntimeConfig({ storeMode: 'offline-only' });
    const refresh = vi.fn(() => Promise.resolve<StoreSchemaState>({ kind: 'ok' }));
    useStoreSchemaStore.setState({ state: stale, checkedAt: 123, refresh });
    useStoreSwitchStore.setState({ state: 'moved' });
    applyObserved('active', 'backend-a');
    expect(refresh).toHaveBeenCalledTimes(1);
    useStoreSchemaStore.setState({ refresh: initial.refresh });
    resetStoreRuntimeConfigForTests();
  });

  it('in cloud mode no probe is fired', () => {
    const refresh = vi.fn(() => Promise.resolve<StoreSchemaState>({ kind: 'ok' }));
    useStoreSchemaStore.setState({ refresh });
    useStoreSwitchStore.setState({ state: 'moved' });
    applyObserved('active', 'backend-a');
    expect(refresh).not.toHaveBeenCalled();
    useStoreSchemaStore.setState({ refresh: initial.refresh });
  });
});

describe('useStoreSwitchState', () => {
  it('polls every 30 s while active and every 10 s once the store is busy', async () => {
    fetchState.mockResolvedValue('active');
    renderHook(() => useStoreSwitchState());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchState).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_ACTIVE_MS);
    });
    expect(fetchState).toHaveBeenCalledTimes(2);
    fetchState.mockResolvedValue('draining');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_ACTIVE_MS);
    });
    expect(useStoreSwitchStore.getState().state).toBe('draining');
    const before = fetchState.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_BUSY_MS);
    });
    expect(fetchState.mock.calls.length).toBe(before + 1);
  });

  it('recheck reads again immediately', async () => {
    fetchState.mockResolvedValue('active');
    const { result } = renderHook(() => useStoreSwitchState());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fetchState.mockResolvedValue('frozen');
    await act(async () => {
      await result.current.recheck();
    });
    expect(useStoreSwitchStore.getState().state).toBe('frozen');
  });
});
