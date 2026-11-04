import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useIdleTimer } from './useIdleTimer';

describe('useIdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire before timeoutMs elapses with no activity', () => {
    const onIdle = vi.fn();
    renderHook(() => {
      useIdleTimer(1000, onIdle, true);
    });

    vi.advanceTimersByTime(999);

    expect(onIdle).not.toHaveBeenCalled();
  });

  it('fires exactly once after timeoutMs of silence', () => {
    const onIdle = vi.fn();
    renderHook(() => {
      useIdleTimer(1000, onIdle, true);
    });

    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('resets the pending timeout on a qualifying activity event (keydown)', () => {
    const onIdle = vi.fn();
    renderHook(() => {
      useIdleTimer(1000, onIdle, true);
    });

    vi.advanceTimersByTime(700);
    window.dispatchEvent(new KeyboardEvent('keydown'));
    vi.advanceTimersByTime(700);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('never fires when enabled=false', () => {
    const onIdle = vi.fn();
    renderHook(() => {
      useIdleTimer(1000, onIdle, false);
    });

    vi.advanceTimersByTime(5000);

    expect(onIdle).not.toHaveBeenCalled();
  });

  it('clears its pending timeout on unmount', () => {
    const onIdle = vi.fn();
    const { unmount } = renderHook(() => {
      useIdleTimer(1000, onIdle, true);
    });

    vi.advanceTimersByTime(700);
    unmount();
    vi.advanceTimersByTime(5000);

    expect(onIdle).not.toHaveBeenCalled();
  });
});
