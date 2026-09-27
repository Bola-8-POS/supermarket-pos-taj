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

const CASHIER_ACTIONS: ReadonlySet<StaffAction> = new Set([
  'create_order',
  'view_own_tabs',
  'view_all_tabs', // any cashier can see and operate any open tab
  'clock_in',
  'clock_out',
  'close_tab', // cashiers can process payments via PIN verification
]);

const MANAGER_EXTRA: ReadonlySet<StaffAction> = new Set([
  'close_tab',
  'view_reports',
  'adjust_inventory',
  'manage_products',
  'manage_caja', // open and close the daily caja session
  'process_refund', // process payment refunds (manager+ only)
  'view_audit_log', // view /audit page — manager+ only
  'edit_paid_tab', // correct a paid tab after the fact — manager+ only
  'reopen_tab', // reopen a closed/paid tab — manager+ only (D-04)
  'confirm_transfer_payment', // confirm a pending bank-transfer sale — manager+ only (Phase 23, D-07)
  'dispute_transfer_payment', // dispute a pending bank-transfer sale — manager+ only (Phase 23, D-07)
  'apply_custom_discount', // ad-hoc discount + below-cost floor-guard override — manager+ only (Phase 27, PROMO-05/07)
]);

const KITCHEN_ACTIONS: ReadonlySet<StaffAction> = new Set(['clock_in', 'clock_out']);

const ADMIN_EXTRA: ReadonlySet<StaffAction> = new Set([
  'manage_staff',
  'manage_settings',
  'delete_tab',
  'view_all_shifts',
  'manage_promotions', // admin-only, PROMO-01
]);

const MANAGER_ACTIONS: ReadonlySet<StaffAction> = new Set([...CASHIER_ACTIONS, ...MANAGER_EXTRA]);

const ADMIN_ACTIONS: ReadonlySet<StaffAction> = new Set([...MANAGER_ACTIONS, ...ADMIN_EXTRA]);

const ROLE_SET: Record<StaffRole, ReadonlySet<StaffAction>> = {
  cashier: CASHIER_ACTIONS,
  manager: MANAGER_ACTIONS,
  admin: ADMIN_ACTIONS,
  kitchen: KITCHEN_ACTIONS,
};

/** Actions that require admin (tooltip copy). */
const ADMIN_ONLY_ACTIONS: ReadonlySet<StaffAction> = ADMIN_EXTRA;

export function canAccess(role: StaffRole | null | undefined, action: string): boolean {
  if (role == null) return false;
  return ROLE_SET[role].has(action as StaffAction);
}

export function isStaffAction(action: string): action is StaffAction {
  return (STAFF_ACTIONS as readonly string[]).includes(action);
}

/** Tooltip when the control is disabled due to RBAC. */
export function rbacDenialMessage(action: StaffAction): string {
  if (ADMIN_ONLY_ACTIONS.has(action)) {
    return 'Admin access required';
  }
  return 'Manager access required';
}
