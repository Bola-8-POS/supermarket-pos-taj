import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Staff, Shift } from '@shared/lib/domain';
import i18n, { i18nReady } from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import type { StaffAction } from '@shared/lib/rbac';
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
   * The signed-in staff member's action list, loaded from the live
   * `role_permissions` matrix at sign-in and kept current by
   * `usePermissionsSync()` while online. `null` means nothing has ever been
   * fetched for the current device/staff (fresh install, or a device
   * upgraded from the pre-matrix client that has not signed in since).
   * `usePermissions()` falls back to this set while the live query has no
   * data; it is the offline continuation of whatever was last confirmed.
   */
  permissions: StaffAction[] | null;
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
   *
   * `permissions`: a real list replaces the persisted action list. `null` or
   * omitted (a fetch that hasn't happened or didn't resolve, e.g. a failed
   * one-shot matrix fetch at sign-in) keeps the persisted list if `staff.id`
   * is unchanged (e.g. `ClockInModal` re-clocking, or `PINLoginForm` re-signing
   * in the same returning staff member after a transient fetch failure) and
   * clears it otherwise (a different staff member signing in with no fetch
   * result to seed from yet).
   */
  login: (staff: Staff, shift: Shift, permissions?: StaffAction[] | null) => void;

  /** Clears staff and shift state; called on explicit logout or session expiry. */
  logout: () => void;

  /** Replaces the persisted action list (the live-matrix write-back, and PIN sign-in). */
  setPermissions: (list: StaffAction[]) => void;

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
      permissions: null,

      login: (staff, shift, permissions) => {
        logger.info('staff.loggedIn', { staffId: staff.id, shiftId: shift.id, role: staff.role });
        set(state => ({
          currentStaff: staff,
          currentShift: shift,
          isAuthenticated: true,
          managerGrantedActions: new Set<string>(),
          permissions:
            permissions != null
              ? permissions
              : state.currentStaff?.id === staff.id
                ? state.permissions
                : null,
        }));
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
          permissions: null,
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

      setPermissions: list => {
        set({ permissions: list });
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
        permissions: state.permissions,
        // managerGrantedActions intentionally NOT persisted — session-only
      }),
      // No onRehydrateStorage here — see the onFinishHydration registration
      // below, right after `useStaffStore` is assigned, for why.
      version: 2,
      // v0 persisted the whole staff record; v1 keeps display fields only.
      // v2 adds `permissions` (the live-matrix action list) — a v1 store has
      // no such field, so it starts null (same as a fresh install) rather
      // than assume anything about what the pre-matrix client's static table
      // would have granted.
      migrate: (persisted, version) => {
        const state = persisted as
          | { currentStaff?: Record<string, unknown> | null; permissions?: unknown }
          | null;
        if (state?.currentStaff) {
          delete state.currentStaff['pin'];
          delete state.currentStaff['email'];
        }
        if (state && version < 2) {
          state.permissions = null;
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
