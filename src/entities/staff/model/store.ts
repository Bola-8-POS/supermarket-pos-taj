import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { offlineSalesBlock } from '@entities/offline-sale';
import { UserRoleSchema, type Staff, type Shift } from '@shared/lib/domain';
import i18n, { i18nReady } from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import type { StaffAction } from '@shared/lib/rbac';
import { err, ok, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { revokeIfInactive } from './offlineApproval';
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
  /**
   * True while the server-side sign-out of the last explicit logout has not been confirmed
   * (timed out or failed, e.g. during an outage). Persisted: the cashier's auth session is
   * still in storage and auth-js would keep refreshing it, so the app retries the sign-out
   * (`retrySignOut`) when a refreshed session shows up while nobody is signed in.
   */
  signOutPending: boolean;
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

  /**
   * Clears staff and shift state at once, then waits (at most SIGN_OUT_WAIT_MS) for the server-side sign-out so a caller can order its navigate after it (the till is already locked; redirects do not wait for this promise).
   *
   * Refuses (`OFFLINE_SALES_PENDING`, nothing cleared) while the signed-in staff member owns
   * unconfirmed offline sales. `force: true` is for system sign-outs (session lost or
   * mismatched), which are never refused; a user-initiated caller must check the result.
   */
  logout: (opts?: { force?: boolean }) => Promise<Result<void>>;

  /** Re-attempts the bounded server-side sign-out of a logout that never confirmed. No-op unless `signOutPending`. */
  retrySignOut: () => Promise<void>;

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
/** How long logout() waits for the network sign-out before letting the caller move on. */
const SIGN_OUT_WAIT_MS = 3_000;

async function settleWithin<T>(work: PromiseLike<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const useStaffStore = create<StaffStore>()(
  persist(
    (set, get) => {
      /** Bounded server-side sign-out; records whether it was confirmed. */
      async function signOutOnServer(
        inFlight: ReturnType<typeof supabase.auth.signOut>
      ): Promise<void> {
        let confirmed = false;
        try {
          const outcome = await settleWithin(inFlight, SIGN_OUT_WAIT_MS);
          if (outcome === undefined) {
            logger.warn('staff.signOut.timed_out', { waitedMs: SIGN_OUT_WAIT_MS });
          } else if (outcome.error) {
            logger.warn('staff.signOut.failed', { message: outcome.error.message });
          } else {
            confirmed = true;
          }
        } catch (err) {
          logger.warn('staff.signOut.failed', {
            message: err instanceof Error ? err.message : 'unknown',
          });
        }
        set({ signOutPending: !confirmed });
      }

      return {
        currentStaff: null,
        currentShift: null,
        staffList: [],
        isAuthenticated: false,
        hasHydrated: false,
        managerGrantedActions: new Set<string>(),
        permissions: null,
        signOutPending: false,

        login: (staff, shift, permissions) => {
          logger.info('staff.loggedIn', { staffId: staff.id, shiftId: shift.id, role: staff.role });
          set(state => ({
            currentStaff: staff,
            currentShift: shift,
            isAuthenticated: true,
            signOutPending: false,
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

        logout: async ({ force }: { force?: boolean } = {}) => {
          // Ruling 13: a staff member who still owns unconfirmed offline sales cannot sign out -
          // the replay needs their session. Enforced here so no UI caller can skip it; forced
          // (system) sign-outs - expired/lost session, session mismatch - are never refused.
          const staffId = get().currentStaff?.id;
          const blocked =
            force || staffId === undefined ? undefined : offlineSalesBlock('signOut', staffId);
          if (blocked) return err(blocked);
          clearOfflineUnlock();
          logger.info('staff.loggedOut');
          const signingOut = supabase.auth.signOut();
          set({
            currentStaff: null,
            currentShift: null,
            staffList: [],
            isAuthenticated: false,
            managerGrantedActions: new Set<string>(),
            permissions: null,
          });
          // S2B: local state is cleared first, so the till locks at once (ProtectedRoute redirects
          // on `isAuthenticated`, not on this promise); the network sign-out carries on in the
          // background and awaiting here only orders a caller's explicit navigate after it. The
          // wait is bounded so an unreachable server cannot freeze the caller. An unconfirmed
          // sign-out leaves the auth session in storage, hence `signOutPending` (see retrySignOut).
          await signOutOnServer(signingOut);
          return ok(undefined);
        },

        retrySignOut: async () => {
          if (!get().signOutPending) return;
          // Final review 2: may fire hours later — local scope, so sessions started since on another till stay alive.
          await signOutOnServer(supabase.auth.signOut({ scope: 'local' }));
        },

        updateShift: shift => {
          logger.info('staff.shift.updated', { shiftId: shift.id });
          set({ currentShift: shift });
        },

        setStaffList: staff => {
          logger.info('staff.list.loaded', { count: staff.length });
          // The directory lists active staff only: a signed-in staff member or a
          // grant issuer missing from it was deactivated, so drop their offline
          // authority now rather than at their next online check.
          revokeIfInactive(staff);
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
      };
    },
    {
      name: 'staff-store',
      partialize: state => ({
        currentStaff: state.currentStaff,
        currentShift: state.currentShift,
        isAuthenticated: state.isAuthenticated,
        permissions: state.permissions,
        signOutPending: state.signOutPending,
        // managerGrantedActions intentionally NOT persisted — session-only
      }),
      // No onRehydrateStorage here — see the onFinishHydration registration
      // below, right after `useStaffStore` is assigned, for why.
      version: 3,
      // v0 persisted the whole staff record; v1 keeps display fields only.
      // v2 adds `permissions` (the live-matrix action list) — a v1 store has
      // no such field, so it starts null (same as a fresh install) rather
      // than assume anything about what the pre-matrix client's static table
      // would have granted.
      // v3 retires the kitchen role: a persisted session whose role is not a
      // current role is signed out on rehydrate (fail closed).
      migrate: (persisted, version) => {
        const state = persisted as {
          currentStaff?: Record<string, unknown> | null;
          currentShift?: unknown;
          permissions?: unknown;
          isAuthenticated?: boolean;
          signOutPending?: boolean;
        } | null;
        if (state?.currentStaff) {
          delete state.currentStaff['pin'];
          delete state.currentStaff['email'];
        }
        if (state && version < 2) {
          state.permissions = null;
        }
        if (state?.currentStaff && !UserRoleSchema.safeParse(state.currentStaff['role']).success) {
          state.currentStaff = null;
          state.currentShift = null;
          state.permissions = null;
          state.isAuthenticated = false;
          // Revoke the Supabase session (retryPendingSignOut) and drop any
          // offline-unlock verifier so the retired role cannot linger.
          state.signOutPending = true;
          clearOfflineUnlock();
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
