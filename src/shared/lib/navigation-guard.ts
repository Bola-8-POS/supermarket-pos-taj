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
