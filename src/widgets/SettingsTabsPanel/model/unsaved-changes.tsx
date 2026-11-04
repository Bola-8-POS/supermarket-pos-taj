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
  requestLeave: () => Promise<boolean>;
  dialogProps: {
    open: boolean;
    saving: boolean;
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
  };
} {
  const dirtyRef = useRef(false);
  const saveRef = useRef<SaveHandler>(NOOP_SAVE);
  const resolverRef = useRef<((proceed: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const report = useCallback((dirty: boolean, save: SaveHandler) => {
    dirtyRef.current = dirty;
    saveRef.current = save;
  }, []);

  const clear = useCallback(() => {
    dirtyRef.current = false;
    saveRef.current = NOOP_SAVE;
  }, []);

  const registry = useMemo<UnsavedChangesRegistry>(() => ({ report, clear }), [report, clear]);

  const isDirty = useCallback(() => dirtyRef.current, []);

  const settle = useCallback((proceed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    setSaving(false);
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
    setSaving(true);
    void saveRef
      .current()
      .then(ok => {
        if (ok) {
          settle(true);
        } else {
          setSaving(false);
        }
      })
      // A rejected save (thrown error, not merely a `false` result) must be
      // treated the same as `false` — stay open, reset `saving` — instead of
      // becoming an unhandled rejection that leaves every button disabled.
      .catch(() => {
        setSaving(false);
      });
  }, [settle]);

  const onDiscard = useCallback(() => {
    settle(true);
  }, [settle]);

  const onCancel = useCallback(() => {
    settle(false);
  }, [settle]);

  return {
    registry,
    isDirty,
    requestLeave,
    dialogProps: { open, saving, onSave, onDiscard, onCancel },
  };
}
