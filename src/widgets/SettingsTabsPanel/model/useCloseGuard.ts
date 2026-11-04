import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';

/**
 * APP-CLOSE GUARD
 *
 * Mirrors the tab-switch/navigation unsaved-changes prompt
 * (`useUnsavedChangesController`) for the one remaining way to leave a dirty
 * Settings tab without going through either: closing the app window itself.
 * Tauri intercepts the native close request; a plain browser tab (e.g. `npm
 * run dev`) falls back to `beforeunload`.
 */
export function useCloseGuard(isDirty: () => boolean, requestLeave: () => Promise<boolean>): void {
  useEffect(() => {
    if (isTauri()) {
      const win = getCurrentWindow();
      const unlisten = win.onCloseRequested(async event => {
        if (!isDirty()) return;
        event.preventDefault();
        if (await requestLeave()) void win.destroy();
      });
      return () => {
        void unlisten.then(fn => {
          fn();
        });
      };
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      e.preventDefault();
      // returnValue is deprecated but still required by Chromium/WebView2 to
      // show the native "leave site?" prompt — preventDefault() alone is not
      // enough on the engine this app ships to end users on.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [isDirty, requestLeave]);
}
