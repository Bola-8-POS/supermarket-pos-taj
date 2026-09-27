import type { UserRole } from '@shared/lib/domain';

/** Same as persisted profile role — alias for RBAC naming. */
export type StaffRole = UserRole;

export const STAFF_ROLES = [
  'cashier',
  'manager',
  'admin',
  'kitchen',
] as const satisfies readonly StaffRole[];

export const STAFF_ACTIONS = [
  'create_order',
  'view_own_tabs',
  'view_all_tabs',
  'clock_in',
  'clock_out',
  'close_tab',
  'view_reports',
  'adjust_inventory',
  'manage_products',
  'manage_staff',
  'manage_settings',
  'delete_tab',
  'view_all_shifts',
  'manage_caja',
  'process_refund',
  'view_audit_log',
  'edit_paid_tab',
  'reopen_tab',
  'confirm_transfer_payment',
  'dispute_transfer_payment',
  'manage_promotions',
  'apply_custom_discount',
] as const;

export type StaffAction = (typeof STAFF_ACTIONS)[number];

/**
 * Actions whose tooltip copy says "Admin access required" instead of
 * "Manager access required" when `ProtectedAction` disables a control. This
 * drives DENIAL COPY ONLY — it is not consulted for authorization. `can()`
 * (`usePermissions`) is the sole gate, sourced from the live `role_permissions`
 * matrix; a role's real access can differ from what this list implies once an
 * admin edits the matrix on `/rbac`, and the tooltip text does not follow.
 */
const ADMIN_ONLY_ACTION_COPY: ReadonlySet<StaffAction> = new Set([
  'manage_staff',
  'manage_settings',
  'delete_tab',
  'view_all_shifts',
  'manage_promotions',
]);

export function isStaffAction(action: string): action is StaffAction {
  return (STAFF_ACTIONS as readonly string[]).includes(action);
}

/** Tooltip when the control is disabled due to RBAC. */
export function rbacDenialMessage(action: StaffAction): string {
  if (ADMIN_ONLY_ACTION_COPY.has(action)) {
    return 'Admin access required';
  }
  return 'Manager access required';
}
