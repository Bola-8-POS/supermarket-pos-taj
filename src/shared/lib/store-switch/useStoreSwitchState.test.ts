import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchState = vi.fn();
vi.mock('./client', () => ({
  fetchStoreSwitchState: () => fetchState(),
  backendKey: () => 'backend-a',
}));

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
