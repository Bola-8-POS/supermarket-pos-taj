import { useEffect, useRef } from 'react';

/* eslint-disable i18next/no-literal-string -- DOM event names, not UI copy */
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
/* eslint-enable i18next/no-literal-string */

/**
 * Fires `onIdle` after `timeoutMs` of no qualifying DOM activity. The pending
 * timeout resets on every activity event and is fully cleared (not merely
 * ignored) whenever `enabled` is false — callers must pass
 * `enabled={isAuthenticated && !locked}` so PIN-entry keystrokes on the lock
 * overlay never reset the "time until re-lock" countdown (RESEARCH.md
 * Pitfall 4).
 */
export function useIdleTimer(timeoutMs: number, onIdle: () => void, enabled: boolean): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    const reset = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(onIdle, timeoutMs);
    };

    reset();
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, reset, { passive: true, capture: true });
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, reset, { capture: true });
      }
    };
  }, [timeoutMs, onIdle, enabled]);
}
