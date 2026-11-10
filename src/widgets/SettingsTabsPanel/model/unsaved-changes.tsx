/**
 * UNSAVED-CHANGES REGISTRY
 *
 * SettingsTabsPanel renders its tabs as controlled Radix Tabs, which unmounts
 * the inactive TabsContent — so a tab's local `dirty` form state would
 * otherwise be silently dropped on tab switch. Each mounted tab reports its
 * dirty/save state to this registry via `useRegisterUnsavedChanges`; the
 * panel's `useUnsavedChangesController` owns the registry and prompts
 * Save/Discard/Cancel before letting a tab switch (or an app-level
 * navigation, via `navigation-guard.ts`) proceed.
 */

/* eslint-disable react-refresh/only-export-components -- model file: hooks + a context object, no components */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type SaveHandler = () => Promise<boolean>;

export interface UnsavedChangesRegistry {
  /** Called from an effect by the mounted tab. */
  report: (dirty: boolean, save: SaveHandler) => void;
  /** Called on tab unmount. */
  clear: () => void;
}

export const UnsavedChangesContext = createContext<UnsavedChangesRegistry | null>(null);

/** Tabs call this. No-op when rendered outside SettingsTabsPanel (unit tests of a tab alone). */
export function useRegisterUnsavedChanges(dirty: boolean, save: SaveHandler): void {
  const registry = useContext(UnsavedChangesContext);
  // Tabs recreate the `save` closure every render — stash the latest one in a
  // ref (updated in its own effect, never during render) so the effect below
  // only needs `dirty` as a dependency.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    registry?.report(dirty, () => saveRef.current());
  }, [registry, dirty]);

  useEffect(() => {
    return () => registry?.clear();
  }, [registry]);
}

const NOOP_SAVE: SaveHandler = () => Promise.resolve(true);

/** Panel-side hook: owns refs + prompt state. */
export function useUnsavedChangesController(): {
  registry: UnsavedChangesRegistry;
  isDirty: () => boolean;
  /** Reactive twin of isDirty, for effects that install/remove a guard. */
  dirty: boolean;
  requestLeave: () => Promise<boolean>;
  dialogProps: {
    open: boolean;
    saving: boolean;
    saveError: boolean;
    onSave: () => void;
    onDiscard: () => void;
    onStay: () => void;
  };
} {
  const dirtyRef = useRef(false);
  const saveRef = useRef<SaveHandler>(NOOP_SAVE);
  const resolverRef = useRef<((proceed: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Synchronous in-flight latch: `saving` state lags a render behind a fast double click.
  const savingRef = useRef(false);

  const report = useCallback((isDirtyNow: boolean, save: SaveHandler) => {
    dirtyRef.current = isDirtyNow;
    saveRef.current = save;
    setDirty(isDirtyNow);
  }, []);

  const clear = useCallback(() => {
    dirtyRef.current = false;
    saveRef.current = NOOP_SAVE;
    setDirty(false);
  }, []);

  const registry = useMemo<UnsavedChangesRegistry>(() => ({ report, clear }), [report, clear]);

  const isDirty = useCallback(() => dirtyRef.current, []);

  const settle = useCallback((proceed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    savingRef.current = false;
    setOpen(false);
    setSaving(false);
    setSaveError(false);
    if (proceed) {
      dirtyRef.current = false;
      setDirty(false);
    }
    resolve?.(proceed);
  }, []);

  const requestLeave = useCallback((): Promise<boolean> => {
    if (!dirtyRef.current) return Promise.resolve(true);
    // Only one pending request at a time — a second call while the dialog is
    // already open (e.g. a fast double-click) resolves false immediately.
    if (resolverRef.current) return Promise.resolve(false);

    setOpen(true);
    return new Promise<boolean>(resolve => {
      resolverRef.current = resolve;
    });
  }, []);

  const onSave = useCallback(() => {
    if (savingRef.current || !resolverRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(false);
    const fail = () => {
      savingRef.current = false;
      setSaving(false);
      setSaveError(true);
    };
    // A rejected save (thrown error, not merely a `false` result) is treated
    // the same as `false`: stay open with an error and allow Retry Save.
    void saveRef
      .current()
      .then(ok => {
        if (ok) settle(true);
        else fail();
      })
      .catch(fail);
  }, [settle]);

  const onDiscard = useCallback(() => {
    settle(true);
  }, [settle]);

  const onStay = useCallback(() => {
    // Ignored while a save is in flight: the dialog waits for it to settle.
    if (savingRef.current) return;
    settle(false);
  }, [settle]);

  return {
    registry,
    isDirty,
    dirty,
    requestLeave,
    dialogProps: { open, saving, saveError, onSave, onDiscard, onStay },
  };
}
