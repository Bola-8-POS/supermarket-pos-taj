import { useEffect, useMemo } from 'react';
import { useRolePermissions } from '@entities/rbac';
import type { StaffAction } from '@shared/lib/rbac';
import { useStaffStore } from './store';

const EMPTY_SET: ReadonlySet<StaffAction> = new Set();

export interface UsePermissionsResult {
  can: (action: string) => boolean;
  /**
   * False only while nothing is known yet (no live query result, nothing
   * persisted) — route guards render nothing rather than redirect during
   * this window. True once the live query has settled (success OR error) or
   * a persisted set exists, even if the settled result is "no data".
   */
  ready: boolean;
}

/**
 * The client's only gate. `can()` prefers the live `role_permissions` matrix
 * (via `useRolePermissions()`) over the persisted set written back by
 * `usePermissionsSync()`; the persisted set is used only while the live
 * query has no data at all (still loading, or the query itself is
 * `enabled: false`). A successful fetch that names the current role but
 * omits it from the map (every row removed for that role) yields an empty
 * live set, not a fallback to the persisted list — the live matrix always
 * wins once it answers.
 */
export function usePermissions(): UsePermissionsResult {
  const role = useStaffStore(s => s.currentStaff?.role);
  const persisted = useStaffStore(s => s.permissions);
  const managerGrantedActions = useStaffStore(s => s.managerGrantedActions);
  const query = useRolePermissions();

  return useMemo(() => {
    if (role == null) {
      return { can: () => false, ready: false };
    }

    const live = query.data?.ok ? (query.data.data.get(role) ?? EMPTY_SET) : undefined;
    const source = live ?? (persisted ? new Set(persisted) : undefined);
    const settled = query.data !== undefined || query.isError;
    const ready = source !== undefined || settled;

    const can = (action: string): boolean =>
      (source?.has(action as StaffAction) ?? false) || managerGrantedActions.has(action);

    return { can, ready };
  }, [role, persisted, managerGrantedActions, query.data, query.isError]);
}

/**
 * Writes the live matrix back into the persisted store so the signed-in
 * staff member's gates keep working across a reload while offline. Mounted
 * exactly ONCE (in `ShellLayout`, not inside `usePermissions()` itself,
 * which has dozens of call sites) — running it per-instance would still be
 * correct (the comparison below is idempotent) but wasteful.
 */
export function usePermissionsSync(): void {
  const role = useStaffStore(s => s.currentStaff?.role);
  const persisted = useStaffStore(s => s.permissions);
  const setPermissions = useStaffStore(s => s.setPermissions);
  const query = useRolePermissions();

  useEffect(() => {
    if (role == null || !query.data?.ok) return;

    const live = [...(query.data.data.get(role) ?? EMPTY_SET)].sort();
    const current = persisted ? [...persisted].sort() : null;
    const same =
      current !== null &&
      current.length === live.length &&
      current.every((action, i) => action === live[i]);

    if (!same) {
      setPermissions(live);
    }
  }, [role, persisted, query.data, setPermissions]);
}
