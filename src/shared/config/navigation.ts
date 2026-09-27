/**
 * App navigation manifest.
 *
 * Single source of truth for every top-level destination: the sidebar rail
 * and the Home dashboard tiles both render from this list, so a route can't
 * be reachable from one and missing from the other. Labels resolve through
 * the `wPanels` namespace (`homeDashboard.tiles.*`) to keep the existing
 * catalog entries.
 */

import {
  BarChart3,
  ClipboardList,
  CreditCard,
  FileText,
  History,
  Package,
  Percent,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { FeatureKey } from '@shared/lib/license/features';
import type { StaffAction } from '@shared/lib/rbac';

export type NavGroup = 'sell' | 'stock' | 'manage';

export type NavItem = {
  path: string;
  /** i18n key inside the `wPanels` namespace */
  labelKey: string;
  icon: LucideIcon;
  group: NavGroup;
  requiredAction?: StaffAction;
  /** i18n key (wPanels) for the "Manager"/"Admin" chip shown on gated tiles */
  managerLabelKey?: string;
  /** License entitlement gating this destination, if any. */
  feature?: FeatureKey;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/pos', labelKey: 'homeDashboard.tiles.pos', icon: ShoppingCart, group: 'sell' },
  { path: '/payments', labelKey: 'homeDashboard.tiles.payments', icon: CreditCard, group: 'sell' },
  { path: '/staff', labelKey: 'homeDashboard.tiles.staff', icon: Users, group: 'manage' },
  {
    path: '/reports',
    labelKey: 'homeDashboard.tiles.reports',
    icon: BarChart3,
    group: 'manage',
    requiredAction: 'view_reports',
    managerLabelKey: 'homeDashboard.managerLabels.manager',
  },
  {
    path: '/inventory',
    labelKey: 'homeDashboard.tiles.inventory',
    icon: Package,
    group: 'stock',
    requiredAction: 'adjust_inventory',
    managerLabelKey: 'homeDashboard.managerLabels.manager',
  },
  {
    path: '/suppliers',
    labelKey: 'homeDashboard.tiles.suppliers',
    icon: Truck,
    group: 'stock',
    requiredAction: 'adjust_inventory',
    managerLabelKey: 'homeDashboard.managerLabels.manager',
  },
  {
    path: '/purchase-orders',
    labelKey: 'homeDashboard.tiles.purchaseOrders',
    icon: FileText,
    group: 'stock',
    requiredAction: 'manage_products',
    managerLabelKey: 'homeDashboard.managerLabels.manager',
  },
  {
    path: '/settings',
    labelKey: 'homeDashboard.tiles.settings',
    icon: Settings,
    group: 'manage',
    requiredAction: 'manage_settings',
    managerLabelKey: 'homeDashboard.managerLabels.admin',
  },
  {
    path: '/promotions',
    labelKey: 'homeDashboard.tiles.promotions',
    icon: Percent,
    group: 'stock',
    requiredAction: 'manage_promotions',
    managerLabelKey: 'homeDashboard.managerLabels.admin',
  },
  {
    path: '/rbac',
    labelKey: 'homeDashboard.tiles.rolesAndPermissions',
    icon: ShieldCheck,
    group: 'manage',
    requiredAction: 'manage_staff',
    managerLabelKey: 'homeDashboard.managerLabels.admin',
  },
  {
    path: '/audit',
    labelKey: 'homeDashboard.tiles.auditLog',
    icon: ClipboardList,
    group: 'manage',
    requiredAction: 'view_audit_log',
    managerLabelKey: 'homeDashboard.managerLabels.manager',
    feature: 'audit_log',
  },
  {
    path: '/edit-history',
    labelKey: 'homeDashboard.tiles.editHistory',
    icon: History,
    group: 'manage',
    requiredAction: 'view_audit_log',
    managerLabelKey: 'homeDashboard.managerLabels.manager',
    feature: 'edit_history',
  },
];

export const NAV_GROUPS: readonly { key: NavGroup; labelKey: string }[] = [
  { key: 'sell', labelKey: 'appShell.groups.sell' },
  { key: 'stock', labelKey: 'appShell.groups.stock' },
  { key: 'manage', labelKey: 'appShell.groups.manage' },
];
