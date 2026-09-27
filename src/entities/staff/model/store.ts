import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Staff, Shift } from '@shared/lib/domain';
import i18n, { i18nReady } from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';
import { clearOfflineUnlock } from './offlineUnlock';
/* eslint-disable i18next/no-literal-string -- zustand persist store name below
   is a localStorage key, not UI copy. */

interface StaffState {
  currentStaff: Staff | null;
  currentShift: Shift | null;
  /** Active staff profiles from server; refreshed by `useStaffList`. */
  staffList: Staff[];
  isAuthenticated: boolean;
  /**
   * True once zustand's persist middleware has finished reading localStorage
   * and applying the restored state. `persist` hydration runs in a microtask
   * AFTER React's first paint, so any consumer that gates on `isAuthenticated`
   * before this flag is true (e.g. ProtectedRoute) sees the pre-hydration
   * default (false) on every fresh page load and can redirect away before the
   * real persisted value is ever applied. Not persisted — reset to false on
   * every load, flips true once by `applyHydratedState` below.
   */
  hasHydrated: boolean;
  /**
   * Actions temporarily unlocked via Manager PIN dialog for the current session.
   * Cleared on logout. Not persisted — intentionally session-scoped.
   */
  managerGrantedActions: ReadonlySet<string>;
}

interface StaffActions {
  /**
   * Sets the logged-in staff member and their active shift.
   * Called after a successful PIN auth + shift lookup / creation.
   */
  login: (staff: Staff, shift: Shift) => void;

  /** Clears staff and shift state; called on explicit logout or session expiry. */
  logout: () => void;

  /** Replaces the current shift (e.g. after clock-out or opening cash update). */
  updateShift: (shift: Shift) => void;

  /** Replaces cached staff directory from TanStack Query. */
  setStaffList: (staff: Staff[]) => void;

  /** Grants a set of actions via Manager PIN approval for this session. */
  grantManagerActions: (actions: string[]) => void;
}

type StaffStore = StaffState & StaffActions;

/** Persisted so staff do not need to re-authenticate on page reload. */
export const useStaffStore = create<StaffStore>()(
  persist(
    set => ({
      currentStaff: null,
      currentShift: null,
      staffList: [],
      isAuthenticated: false,
      hasHydrated: false,
      managerGrantedActions: new Set<string>(),

      login: (staff, shift) => {
        logger.info('staff.loggedIn', { staffId: staff.id, shiftId: shift.id, role: staff.role });
        set({
          currentStaff: staff,
          currentShift: shift,
          isAuthenticated: true,
          managerGrantedActions: new Set<string>(),
        });
        // D-01/D-02: locale is staff-attribute-driven, never navigator.language —
        // prevents one staff member's language leaking onto the next shift's
        // login on the same shared kiosk terminal.
        // Await i18nReady first — i18next.init() is async even with every
        // resource provided synchronously (no backend); a changeLanguage()
        // call issued before init's own `lng` assignment settles is silently
        // overwritten once init resolves (see i18nReady's doc comment).
        void i18nReady.then(() => i18n.changeLanguage(staff.locale));
      },

      logout: () => {
        clearOfflineUnlock();
        logger.info('staff.loggedOut');
        void supabase.auth.signOut();
        set({
          currentStaff: null,
          currentShift: null,
          staffList: [],
          isAuthenticated: false,
          managerGrantedActions: new Set<string>(),
        });
      },

      updateShift: shift => {
        logger.info('staff.shift.updated', { shiftId: shift.id });
        set({ currentShift: shift });
      },

      setStaffList: staff => {
        logger.info('staff.list.loaded', { count: staff.length });
        set({ staffList: staff });
      },

      grantManagerActions: (actions: string[]) => {
        logger.info('staff.managerActions.granted', { actions });
        set(state => ({
          managerGrantedActions: new Set([...state.managerGrantedActions, ...actions]),
        }));
      },
    }),
    {
      name: 'staff-store',
      partialize: state => ({
        currentStaff: state.currentStaff,
        currentShift: state.currentShift,
        isAuthenticated: state.isAuthenticated,
        // managerGrantedActions intentionally NOT persisted — session-only
      }),
      // No onRehydrateStorage here — see the onFinishHydration registration
      // below, right after `useStaffStore` is assigned, for why.
      version: 1,
      // v0 persisted the whole staff record; v1 keeps display fields only.
      migrate: persisted => {
        const state = persisted as { currentStaff?: Record<string, unknown> | null } | null;
        if (state?.currentStaff) {
          delete state.currentStaff['pin'];
          delete state.currentStaff['email'];
        }
        return state as never;
      },
    }
  )
);

// Registered as a separate statement AFTER `useStaffStore` exists (not via
// the `persist()` config's `onRehydrateStorage` option) — that option's
// callback runs asynchronously via zustand's own promise chain, but on a
// microtask tick that can fire before this module's top-level
// `export const useStaffStore = ...` binding has finished initializing.
// Referencing `useStaffStore` from inside an `onRehydrateStorage` callback
// then throws `ReferenceError: Cannot access 'useStaffStore' before
// initialization` (TDZ), which zustand's persist middleware silently
// swallows in its own internal `.catch()` — permanently stranding
// `hasHydrated` at `false` and skipping every line after the throw,
// including the locale-restoring `i18n.changeLanguage()` call below. That
// silent failure is why a staff member's non-default (en-US) locale never
// survived a page reload: this exact code, unmodified in behavior, worked
// for es-MX only because es-MX already matched i18next's own `lng` default,
// masking the bug. `onFinishHydration` fires from the identical internal
// hydration-complete step, but is registered here — after `useStaffStore`'s
// binding is fully live — so no TDZ reference is possible.
function applyHydratedState(state: StaffStore): void {
  useStaffStore.setState({ hasHydrated: true });
  // Reloaded page / restored session: re-apply the persisted staff's locale
  // (D-01) rather than defaulting to navigator.language. Await i18nReady
  // first — i18next.init() is async even with every resource provided
  // synchronously (no backend); a changeLanguage() call issued before
  // init's own `lng` assignment settles is silently overwritten once init
  // resolves.
  const staffLocale = state.currentStaff?.locale;
  if (staffLocale) {
    void i18nReady.then(() => i18n.changeLanguage(staffLocale));
  }
}

// zustand's persist middleware calls `hydrate()` synchronously during
// `create()` above, but its completion (the point where
// `finishHydrationListeners` fires) can resolve before this module's own
// top-level execution reaches the `onFinishHydration` registration below —
// observed empirically via `persist.hasHydrated()` already reading `true`
// immediately after store creation. Registering unconditionally would then
// silently miss the one-and-only hydration-finished event. Check first;
// apply directly if hydration already finished, otherwise register.
if (useStaffStore.persist.hasHydrated()) {
  applyHydratedState(useStaffStore.getState());
} else {
  useStaffStore.persist.onFinishHydration(applyHydratedState);
}
