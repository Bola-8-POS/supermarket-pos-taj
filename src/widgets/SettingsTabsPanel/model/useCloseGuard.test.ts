import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { onCloseRequestedMock, destroyMock, unlistenMock } = vi.hoisted(() => ({
  onCloseRequestedMock: vi.fn(),
  destroyMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

let isTauriValue = true;

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => isTauriValue,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: onCloseRequestedMock,
    destroy: destroyMock,
  }),
}));

import { useCloseGuard } from './useCloseGuard';

describe('useCloseGuard — Tauri branch', () => {
  let capturedHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | null;

  beforeEach(() => {
    isTauriValue = true;
    capturedHandler = null;
    onCloseRequestedMock.mockReset();
    destroyMock.mockReset();
    unlistenMock.mockReset();
    onCloseRequestedMock.mockImplementation(async (cb: typeof capturedHandler) => {
      capturedHandler = cb;
      return unlistenMock;
    });
  });

  it('prevents close and destroys the window when dirty and requestLeave resolves true', async () => {
    const isDirty = vi.fn(() => true);
    const requestLeave = vi.fn().mockResolvedValue(true);
    renderHook(() => {
      useCloseGuard(isDirty, requestLeave);
    });

    // onCloseRequested is registered asynchronously (async effect callback)
    await vi.waitFor(() => { expect(capturedHandler).not.toBeNull(); });

    const preventDefault = vi.fn();
    await capturedHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(requestLeave).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('prevents close but does not destroy when requestLeave resolves false', async () => {
    const isDirty = vi.fn(() => true);
    const requestLeave = vi.fn().mockResolvedValue(false);
    renderHook(() => {
      useCloseGuard(isDirty, requestLeave);
    });

    await vi.waitFor(() => { expect(capturedHandler).not.toBeNull(); });

    const preventDefault = vi.fn();
    await capturedHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('does not call preventDefault when not dirty', async () => {
    const isDirty = vi.fn(() => false);
    const requestLeave = vi.fn().mockResolvedValue(true);
    renderHook(() => {
      useCloseGuard(isDirty, requestLeave);
    });

    await vi.waitFor(() => { expect(capturedHandler).not.toBeNull(); });

    const preventDefault = vi.fn();
    await capturedHandler?.({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestLeave).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('unlistens on unmount', async () => {
    const isDirty = vi.fn(() => false);
    const requestLeave = vi.fn().mockResolvedValue(true);
    const { unmount } = renderHook(() => {
      useCloseGuard(isDirty, requestLeave);
    });

    await vi.waitFor(() => { expect(capturedHandler).not.toBeNull(); });
    unmount();

    await vi.waitFor(() => { expect(unlistenMock).toHaveBeenCalledTimes(1); });
  });
});

describe('useCloseGuard — browser fallback', () => {
  beforeEach(() => {
    isTauriValue = false;
  });

  afterEach(() => {
    isTauriValue = true;
  });

  it('prevents unload and sets returnValue when dirty', () => {
    const isDirty = vi.fn(() => true);
    const requestLeave = vi.fn().mockResolvedValue(true);
    renderHook(() => {
      useCloseGuard(isDirty, requestLeave);
    });

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not prevent unload when not dirty', () => {
    const isDirty = vi.fn(() => false);
    const requestLeave = vi.fn().mockResolvedValue(true);
    renderHook(() => {
      useCloseGuard(isDirty, requestLeave);
    });

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('removes the beforeunload listener on unmount', () => {
    const isDirty = vi.fn(() => true);
    const requestLeave = vi.fn().mockResolvedValue(true);
    const { unmount } = renderHook(() => {
      useCloseGuard(isDirty, requestLeave);
    });
    unmount();

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
