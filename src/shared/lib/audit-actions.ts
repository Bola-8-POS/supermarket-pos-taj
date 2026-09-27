/**
 * audit-actions.ts
 *
 * Master enum of all valid audit log action labels.
 * Format: <entity>.<verb> (lowercase, dot-separated).
 *
 * CI enforcement: src/shared/lib/__tests__/audit-actions.test.ts
 * greps all migration files to assert every record_audit() call uses
 * an action present in AuditActionSchema.options.
 *
 * Phase 14 — SINGLE SOURCE OF TRUTH. Add new actions here before
 * adding record_audit() calls to RPCs.
 */

import { z } from 'zod';

export const AuditActionSchema = z.enum([
  // Payments
  'payment.process',
  'payment.process_split',
  'payment.refund',
  'payment.transfer_marked_pending',
  'payment.transfer_confirmed',
  'payment.transfer_disputed',
  // Tabs
  'tab.close',
  'tab.transfer',
  'tab.void',
  'tab.split',
  'tab.edit_paid',
  'tab.reopen',
  // Order items
  'order_item.remove',
  // Caja
  'caja.open',
  'caja.close',
  'caja.entry',
  // Orders
  'order.create',
  'order.void',
  // Combos
  'combo.add_to_tab',
  // Inventory
  'inventory.deplete',
  'inventory.manual_adjust',
  'inventory.physical_count',
  'inventory.adjust', // Wave 3a: adjust_inventory RPC (manual adjustment + physical count, single audit label for both)
  // Shipments
  'shipment.receive',
  // Prep
  'prep.produce',
  // Permissions
  'permission.toggle',
  'permission.force_pin_change',
  'permission.admin_pin_reset',
  // Staff
  'staff.role_change',
  'staff.create',
  'staff.locale_change',
  'staff.deactivate',
  'staff.reactivate',
  // Settings
  'settings.update',
  // Tip distribution (dropped Phase 1, D-21 — kept for migration-history audit)
  'tip_distribution.compute',
  // Promotions
  'promotion.apply',
  'promotion.create',
  'promotion.update',
  'promotion.deactivate',
  // Open units
  'open_unit.open',
  'open_unit.deplete',
  'open_unit.exhaust',
  'open_unit.void',
  'open_unit.correct',
  'open_unit.override',
  // Screen lock (Phase 21)
  'screen.lock',
  'screen.unlock',
  // Receipts (Wave 3b)
  'receipt.emailed',
  // Audit (wave 3c): the historic-payload scrub's own record, written once
  // per project by a data migration, not by record_audit().
  'audit.redact_keys',
]);
