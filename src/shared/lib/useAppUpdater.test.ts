/**
 * Unit tests for useAppUpdater hook.
 *
 * UPD-01: check() called on mount
 * UPD-02: check() called again after 4-hour interval
 * UPD-05: dismiss returns to idle
 * UPD-07: silent failure on network error / no update
 * UPD-08: progress state updates during download
 */

// Import the module references AFTER vi.mock — test-setup.ts has global mocks
import { check } from '@tauri-apps/plugin-updater';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppUpdater, useUpdaterStore } from '@shared/lib/useAppUpdater';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

describe('useAppUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(check).mockResolvedValue(null);
    // Store is module-global — reset between tests
    useUpdaterStore.setState({ state: { phase: 'idle' }, update: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stays idle when check() returns null (UPD-07)', async () => {
    vi.mocked(check).mockResolvedValue(null);
    const { result } = renderHook(() => useAppUpdater());
    // Flush the void runCheck() promise without running the 4h interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.phase).toBe('idle');
  });

  it('stays idle when check() throws (UPD-07)', async () => {
    vi.mocked(check).mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useAppUpdater());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.phase).toBe('idle');
  });

  it('calls check() on mount (UPD-01)', async () => {
    renderHook(() => useAppUpdater());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(vi.mocked(check)).toHaveBeenCalledTimes(1);
  });

  it('calls check() again after 4 hours (UPD-02)', async () => {
    renderHook(() => useAppUpdater());
    // Flush initial mount check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(vi.mocked(check)).toHaveBeenCalledTimes(1);
    // Advance exactly 4 hours → interval fires once more
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOUR_HOURS_MS);
    });
    expect(vi.mocked(check)).toHaveBeenCalledTimes(2);
  });

  it('transitions to available when update found (UPD-01)', async () => {
    const mockUpdate = {
      version: '2.1.0',
      body: '- New feature\n- Bug fix',
      downloadAndInstall: vi.fn(),
    };
    vi.mocked(check).mockResolvedValue(mockUpdate as never);
    const { result } = renderHook(() => useAppUpdater());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.phase).toBe('available');
    if (result.current.state.phase === 'available') {
      expect(result.current.state.version).toBe('2.1.0');
      expect(result.current.state.changelog).toBe('- New feature\n- Bug fix');
    }
  });

  it('dismissUpdate resets to idle (UPD-05)', async () => {
    const mockUpdate = {
      version: '2.1.0',
      body: '- fixes',
      downloadAndInstall: vi.fn(),
    };
    vi.mocked(check).mockResolvedValue(mockUpdate as never);
    const { result } = renderHook(() => useAppUpdater());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.phase).toBe('available');
    act(() => {
      result.current.dismissUpdate();
    });
    expect(result.current.state.phase).toBe('idle');
  });

  it('startInstall transitions downloading → restart-ready (UPD-08)', async () => {
    // Build a mock downloadAndInstall that emits Started, Progress, Finished
    const downloadAndInstall = vi.fn().mockImplementation(
      async (cb: (event: { event: string; data: Record<string, number | undefined> }) => void) => {
        cb({ event: 'Started', data: { contentLength: 1000 } });
        cb({ event: 'Progress', data: { chunkLength: 420 } });
        cb({ event: 'Finished', data: {} });
      }
    );
    const mockUpdate = {
      version: '2.1.0',
      body: '- fixes',
      downloadAndInstall,
    };
    vi.mocked(check).mockResolvedValue(mockUpdate as never);
    const { result } = renderHook(() => useAppUpdater());
    // Let the mount check resolve → available
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.phase).toBe('available');
    // Start install
    await act(async () => {
      await result.current.startInstall();
    });
    expect(result.current.state.phase).toBe('restart-ready');
    if (result.current.state.phase === 'restart-ready') {
      expect(result.current.state.version).toBe('2.1.0');
    }
  });

  describe('checkForUpdates (manual, Settings → License)', () => {
    it('returns none and stays idle when no update', async () => {
      vi.mocked(check).mockResolvedValue(null);
      await expect(useUpdaterStore.getState().checkForUpdates()).resolves.toBe('none');
      expect(useUpdaterStore.getState().state.phase).toBe('idle');
    });

    it('returns error and stays idle when check() throws', async () => {
      vi.mocked(check).mockRejectedValue(new Error('offline'));
      await expect(useUpdaterStore.getState().checkForUpdates()).resolves.toBe('error');
      expect(useUpdaterStore.getState().state.phase).toBe('idle');
    });

    it('returns available and opens the dialog state when an update exists', async () => {
      vi.mocked(check).mockResolvedValue({ version: '3.0.0', body: 'x', downloadAndInstall: vi.fn() } as never);
      await expect(useUpdaterStore.getState().checkForUpdates()).resolves.toBe('available');
      expect(useUpdaterStore.getState().state).toEqual({ phase: 'available', version: '3.0.0', changelog: 'x' });
    });
  });
});
