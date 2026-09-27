import { act, render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  UnsavedChangesContext,
  useRegisterUnsavedChanges,
  useUnsavedChangesController,
  type SaveHandler,
} from './unsaved-changes';

describe('useUnsavedChangesController', () => {
  it('requestLeave resolves true without opening the dialog when nothing is dirty', async () => {
    const { result } = renderHook(() => useUnsavedChangesController());

    let resolved: boolean | undefined;
    await act(async () => {
      resolved = await result.current.requestLeave();
    });

    expect(resolved).toBe(true);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it('dirty: requestLeave opens the dialog; onCancel resolves false and closes it', async () => {
    const { result } = renderHook(() => useUnsavedChangesController());

    act(() => {
      result.current.registry.report(true, vi.fn().mockResolvedValue(true));
    });

    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.requestLeave();
    });
    expect(result.current.dialogProps.open).toBe(true);

    act(() => {
      result.current.dialogProps.onCancel();
    });

    await expect(promise).resolves.toBe(false);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it('dirty: onDiscard resolves true', async () => {
    const { result } = renderHook(() => useUnsavedChangesController());

    act(() => {
      result.current.registry.report(true, vi.fn().mockResolvedValue(true));
    });

    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.requestLeave();
    });

    act(() => {
      result.current.dialogProps.onDiscard();
    });

    await expect(promise).resolves.toBe(true);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it('dirty, save resolves true: onSave resolves the promise true and closes the dialog', async () => {
    const { result } = renderHook(() => useUnsavedChangesController());

    act(() => {
      result.current.registry.report(true, () => Promise.resolve(true));
    });

    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.requestLeave();
    });

    await act(async () => {
      result.current.dialogProps.onSave();
      await promise;
    });

    await expect(promise).resolves.toBe(true);
    expect(result.current.dialogProps.open).toBe(false);
    expect(result.current.dialogProps.saving).toBe(false);
  });

  it('dirty, save resolves false: dialog stays open, saving resets to false, promise stays pending', async () => {
    const { result } = renderHook(() => useUnsavedChangesController());

    act(() => {
      result.current.registry.report(true, () => Promise.resolve(false));
    });

    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.requestLeave();
    });

    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await act(async () => {
      result.current.dialogProps.onSave();
      // Flush the microtask queue so save()'s resolution is processed.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.dialogProps.open).toBe(true);
    expect(result.current.dialogProps.saving).toBe(false);
    expect(settled).toBe(false);
  });

  it('dirty, save rejects: dialog stays open, saving resets to false, promise stays pending, no unhandled rejection', async () => {
    const { result } = renderHook(() => useUnsavedChangesController());

    act(() => {
      result.current.registry.report(true, () => Promise.reject(new Error('save failed')));
    });

    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.requestLeave();
    });

    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await act(async () => {
      result.current.dialogProps.onSave();
      // Flush the microtask queue so save()'s rejection is processed.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.dialogProps.open).toBe(true);
    expect(result.current.dialogProps.saving).toBe(false);
    expect(settled).toBe(false);
  });

  it('a second requestLeave while the dialog is already open resolves false immediately', async () => {
    const { result } = renderHook(() => useUnsavedChangesController());

    act(() => {
      result.current.registry.report(true, vi.fn().mockResolvedValue(true));
    });

    act(() => {
      void result.current.requestLeave();
    });
    expect(result.current.dialogProps.open).toBe(true);

    await expect(result.current.requestLeave()).resolves.toBe(false);
  });
});

describe('useRegisterUnsavedChanges', () => {
  function TestTab({ dirty, save }: { dirty: boolean; save: SaveHandler }) {
    useRegisterUnsavedChanges(dirty, save);
    return null;
  }

  it('reports on mount, reports again on dirty change, and clears on unmount', () => {
    const registry = { report: vi.fn(), clear: vi.fn() };
    const save = vi.fn().mockResolvedValue(true);

    const { rerender, unmount } = render(
      <UnsavedChangesContext.Provider value={registry}>
        <TestTab dirty={false} save={save} />
      </UnsavedChangesContext.Provider>
    );

    expect(registry.report).toHaveBeenCalledTimes(1);
    expect(registry.report).toHaveBeenLastCalledWith(false, expect.any(Function));

    rerender(
      <UnsavedChangesContext.Provider value={registry}>
        <TestTab dirty={true} save={save} />
      </UnsavedChangesContext.Provider>
    );

    expect(registry.report).toHaveBeenCalledTimes(2);
    expect(registry.report).toHaveBeenLastCalledWith(true, expect.any(Function));

    expect(registry.clear).not.toHaveBeenCalled();
    unmount();
    expect(registry.clear).toHaveBeenCalledTimes(1);
  });

  it('always calls the latest save closure, even though the tab recreates it every render', async () => {
    const registry = { report: vi.fn(), clear: vi.fn() };
    const firstSave = vi.fn().mockResolvedValue(true);
    const secondSave = vi.fn().mockResolvedValue(true);

    const { rerender } = render(
      <UnsavedChangesContext.Provider value={registry}>
        <TestTab dirty={true} save={firstSave} />
      </UnsavedChangesContext.Provider>
    );

    rerender(
      <UnsavedChangesContext.Provider value={registry}>
        <TestTab dirty={true} save={secondSave} />
      </UnsavedChangesContext.Provider>
    );

    const lastReportedSave = registry.report.mock.calls.at(-1)?.[1] as SaveHandler;
    await lastReportedSave();

    expect(secondSave).toHaveBeenCalledTimes(1);
    expect(firstSave).not.toHaveBeenCalled();
  });

  it('is a no-op outside a provider (no throw)', () => {
    expect(() => render(<TestTab dirty={true} save={vi.fn().mockResolvedValue(true)} />)).not.toThrow();
  });
});
