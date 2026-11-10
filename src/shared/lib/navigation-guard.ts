import { create } from 'zustand';

/**
 * A page can install a guard to intercept in-app navigation while it has
 * unsaved state (e.g. Settings with a dirty tab). Resolves `true` to let the
 * navigation proceed, `false` to block it.
 *
 * This exists because the app uses `<BrowserRouter>`, not a data router, so
 * `useBlocker`/`unstable_usePrompt` are unavailable — every navigation path
 * (sidebar links, sign-out, the manager-PIN dialog) must instead call
 * `confirmNavigation()` before navigating.
 */
export type NavigationGuard = () => Promise<boolean>;

interface NavigationGuardState {
  guard: NavigationGuard | null;
  setGuard: (guard: NavigationGuard | null) => void;
}

export const useNavigationGuardStore = create<NavigationGuardState>()(set => ({
  guard: null,
  setGuard: guard => {
    set({ guard });
  },
}));

/** Runs the installed guard (if any). Resolves true when navigation may proceed. */
export async function confirmNavigation(): Promise<boolean> {
  const { guard } = useNavigationGuardStore.getState();
  if (!guard) return true;
  try {
    return await guard();
  } catch {
    // Fail-open: a broken guard must never trap the user on the page.
    return true;
  }
}

const SENTINEL_KEY = '__navGuard';

function onSentinel(): boolean {
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null && SENTINEL_KEY in state;
}

/**
 * Intercepts browser back/forward while a page has unsaved state. `BrowserRouter`
 * has no blocker API, so keep one sentinel history entry on top of the current
 * page: a back press pops it, we immediately re-push it (the router never
 * leaves the page) and hand the caller a `proceed` that replays the original
 * back navigation once. Forward needs nothing: pushing the sentinel truncated
 * forward history. Returns an uninstall function.
 *
 * ponytail: the sentinel is left behind on uninstall or link navigation (one
 * extra Back press lands on the same page).
 */
export function installPopstateGuard(onAttempt: (proceed: () => void) => void): () => void {
  const base: unknown = window.history.state;
  window.history.pushState({ ...(typeof base === 'object' && base !== null ? base : {}), [SENTINEL_KEY]: true }, '');
  let used = false;

  const onPopState = () => {
    if (onSentinel()) return;
    // Landed on the entry below the sentinel: put the sentinel back, stay put.
    window.history.pushState({ ...(typeof base === 'object' && base !== null ? base : {}), [SENTINEL_KEY]: true }, '');
    onAttempt(() => {
      // Still valid after uninstall (Discard/Save flips the page clean, which
      // uninstalls before the caller's continuation runs) as long as the sentinel is on top.
      if (used || !onSentinel()) return;
      used = true;
      window.removeEventListener('popstate', onPopState);
      // Skip the sentinel and the page itself: land on the entry before it.
      window.history.go(-2);
    });
  };
  window.addEventListener('popstate', onPopState);

  // ponytail: never touches history on uninstall. A history.back() here raced the
  // continuation (a Discard-then-navigate was undone by it). The sentinel stays
  // until the user leaves, so one extra Back lands on the same page.
  return () => {
    window.removeEventListener('popstate', onPopState);
  };
}
