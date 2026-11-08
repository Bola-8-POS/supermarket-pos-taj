-- =============================================================================
-- Phase 13: Full DB-level RBAC rewrite — single atomic RLS snapshot
--
-- Purpose: Eliminate the 3 broken/inconsistent RLS patterns that accumulated
-- across 12 migrations. Replace with a single authoritative snapshot using
-- the get_user_role() + EXISTS(role_permissions) canonical pattern.
--
-- Structure:
--   BLOCK 1: DROP ALL EXISTING POLICIES (all tables, all prior migrations)
--   BLOCK 2: CREATE role_permissions table + RLS
--   BLOCK 3: SEED 52 rows matching rbac.ts ROLE_SET exactly
--   BLOCK 4: CREATE ALL NEW RLS POLICIES (canonical pattern)
--   BLOCK 5: DOWN comment
--
-- Broken patterns eliminated:
--   - auth.jwt() ->> 'role' (JWT claim, not profile-table role)
--   - EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role = X)
--   - Mixed policy naming conventions
-- =============================================================================

BEGIN;

-- =============================================================================
-- BLOCK 1: DROP ALL EXISTING POLICIES (dynamic — survives missing tables)
-- =============================================================================
-- Iterates pg_policies and drops every policy in the public schema. This avoids
-- "relation does not exist" errors for tables removed/renamed in prior migrations
-- (e.g. inventory_log → stock_movements, receipt_settings never created on this DB).

DO $rls_drop$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END
$rls_drop$;

-- Original explicit DROP list preserved below as documentation (commented out).
-- These would have been redundant after the dynamic drop above, and several reference
-- relations that no longer exist (inventory_log, receipt_settings on some envs).

/*
-- profiles (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "profiles_select_all" ON profiles;
DROP POLICY IF EXISTS "profiles_insert_admin" ON profiles;
DROP POLICY IF EXISTS "profiles_update_admin" ON profiles;
DROP POLICY IF EXISTS "profiles_delete_admin" ON profiles;

-- shifts (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "shifts_select_bartender" ON shifts;
DROP POLICY IF EXISTS "shifts_select_manager_admin" ON shifts;
DROP POLICY IF EXISTS "shifts_insert_bartender" ON shifts;
DROP POLICY IF EXISTS "shifts_insert_manager_admin" ON shifts;
DROP POLICY IF EXISTS "shifts_update_bartender" ON shifts;
DROP POLICY IF EXISTS "shifts_update_manager_admin" ON shifts;
DROP POLICY IF EXISTS "shifts_delete_admin" ON shifts;

-- categories (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "categories_select_all" ON categories;
DROP POLICY IF EXISTS "categories_insert_manager_admin" ON categories;
DROP POLICY IF EXISTS "categories_update_manager_admin" ON categories;
DROP POLICY IF EXISTS "categories_delete_manager_admin" ON categories;

-- products (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "products_select_all" ON products;
DROP POLICY IF EXISTS "products_insert_manager_admin" ON products;
DROP POLICY IF EXISTS "products_update_manager_admin" ON products;
DROP POLICY IF EXISTS "products_delete_manager_admin" ON products;

-- modifiers (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "modifiers_select_all" ON modifiers;
DROP POLICY IF EXISTS "modifiers_insert_manager_admin" ON modifiers;
DROP POLICY IF EXISTS "modifiers_update_manager_admin" ON modifiers;
DROP POLICY IF EXISTS "modifiers_delete_manager_admin" ON modifiers;

-- product_modifiers (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "product_modifiers_select_all" ON product_modifiers;
DROP POLICY IF EXISTS "product_modifiers_insert_manager_admin" ON product_modifiers;
DROP POLICY IF EXISTS "product_modifiers_delete_manager_admin" ON product_modifiers;

-- tabs (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "tabs_select_bartender" ON tabs;
DROP POLICY IF EXISTS "tabs_select_manager_admin" ON tabs;
DROP POLICY IF EXISTS "tabs_insert_bartender" ON tabs;
DROP POLICY IF EXISTS "tabs_insert_manager_admin" ON tabs;
DROP POLICY IF EXISTS "tabs_update_manager_admin" ON tabs;
DROP POLICY IF EXISTS "tabs_delete_manager_admin" ON tabs;

-- orders (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "orders_select_bartender" ON orders;
DROP POLICY IF EXISTS "orders_select_manager_admin" ON orders;
DROP POLICY IF EXISTS "orders_insert_bartender" ON orders;
DROP POLICY IF EXISTS "orders_insert_manager_admin" ON orders;
DROP POLICY IF EXISTS "orders_update_manager_admin" ON orders;
DROP POLICY IF EXISTS "orders_delete_manager_admin" ON orders;

-- order_items (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "order_items_select_bartender" ON order_items;
DROP POLICY IF EXISTS "order_items_select_manager_admin" ON order_items;
DROP POLICY IF EXISTS "order_items_insert_bartender" ON order_items;
DROP POLICY IF EXISTS "order_items_insert_manager_admin" ON order_items;
DROP POLICY IF EXISTS "order_items_update_manager_admin" ON order_items;
DROP POLICY IF EXISTS "order_items_delete_manager_admin" ON order_items;

-- pool_tables (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "pool_tables_select_all" ON pool_tables;
DROP POLICY IF EXISTS "pool_tables_insert_manager_admin" ON pool_tables;
DROP POLICY IF EXISTS "pool_tables_update_manager_admin" ON pool_tables;
DROP POLICY IF EXISTS "pool_tables_delete_manager_admin" ON pool_tables;

-- pool_sessions (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "pool_sessions_select_bartender" ON pool_sessions;
DROP POLICY IF EXISTS "pool_sessions_select_manager_admin" ON pool_sessions;
DROP POLICY IF EXISTS "pool_sessions_insert_bartender" ON pool_sessions;
DROP POLICY IF EXISTS "pool_sessions_insert_manager_admin" ON pool_sessions;
DROP POLICY IF EXISTS "pool_sessions_update_bartender" ON pool_sessions;
DROP POLICY IF EXISTS "pool_sessions_update_manager_admin" ON pool_sessions;
DROP POLICY IF EXISTS "pool_sessions_delete_manager_admin" ON pool_sessions;

-- payments (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "payments_select_manager_admin" ON payments;
DROP POLICY IF EXISTS "payments_insert_manager_admin" ON payments;
DROP POLICY IF EXISTS "payments_update_admin" ON payments;
DROP POLICY IF EXISTS "payments_delete_admin" ON payments;

-- inventory (20260414000009_rls_policies.sql)
DROP POLICY IF EXISTS "inventory_select_all" ON inventory;
DROP POLICY IF EXISTS "inventory_insert_manager_admin" ON inventory;
DROP POLICY IF EXISTS "inventory_update_manager_admin" ON inventory;
DROP POLICY IF EXISTS "inventory_delete_admin" ON inventory;

-- inventory_log: table renamed to stock_movements — no DROPs needed (relation does not exist)

-- Patchwork policies from 20260420000006_rls_updates.sql
DROP POLICY IF EXISTS "tabs_update_bartender" ON tabs;
DROP POLICY IF EXISTS "payments_select_bartender" ON payments;
DROP POLICY IF EXISTS "stock_movements_select_manager_admin" ON stock_movements;
DROP POLICY IF EXISTS "stock_movements_insert_manager_admin" ON stock_movements;
DROP POLICY IF EXISTS "stock_movements_delete_admin" ON stock_movements;

-- Kitchen role migration (20260423000001)
DROP POLICY IF EXISTS "shifts_select_kitchen" ON shifts;
DROP POLICY IF EXISTS "shifts_insert_kitchen" ON shifts;
DROP POLICY IF EXISTS "shifts_update_kitchen" ON shifts;
DROP POLICY IF EXISTS "order_items_select_kitchen" ON order_items;
DROP POLICY IF EXISTS "order_items_update_kitchen" ON order_items;
DROP POLICY IF EXISTS "orders_select_kitchen" ON orders;
DROP POLICY IF EXISTS "tabs_select_kitchen" ON tabs;
DROP POLICY IF EXISTS "products_select_kitchen" ON products;
DROP POLICY IF EXISTS "categories_select_kitchen" ON categories;

-- modifier_groups migration (20260424000006)
DROP POLICY IF EXISTS "modifier_groups_select_all" ON modifier_groups;
DROP POLICY IF EXISTS "modifier_groups_insert_manager_admin" ON modifier_groups;
DROP POLICY IF EXISTS "modifier_groups_update_manager_admin" ON modifier_groups;
DROP POLICY IF EXISTS "modifier_groups_delete_manager_admin" ON modifier_groups;
DROP POLICY IF EXISTS "modifier_group_items_select_all" ON modifier_group_items;
DROP POLICY IF EXISTS "modifier_group_items_insert_manager_admin" ON modifier_group_items;
DROP POLICY IF EXISTS "modifier_group_items_update_manager_admin" ON modifier_group_items;
DROP POLICY IF EXISTS "modifier_group_items_delete_manager_admin" ON modifier_group_items;
DROP POLICY IF EXISTS "product_modifier_groups_select_all" ON product_modifier_groups;
DROP POLICY IF EXISTS "product_modifier_groups_insert_manager_admin" ON product_modifier_groups;
DROP POLICY IF EXISTS "product_modifier_groups_update_manager_admin" ON product_modifier_groups;
DROP POLICY IF EXISTS "product_modifier_groups_delete_manager_admin" ON product_modifier_groups;

-- Combo migrations (20260425000001 + 20260507000001)
DROP POLICY IF EXISTS "all_auth_select_combo_slots" ON combo_slots;
DROP POLICY IF EXISTS "manager_admin_write_combo_slots" ON combo_slots;
DROP POLICY IF EXISTS "all_auth_select_combo_slot_options" ON combo_slot_options;
DROP POLICY IF EXISTS "manager_admin_write_combo_slot_options" ON combo_slot_options;
DROP POLICY IF EXISTS "all_auth_select_combo_availability" ON combo_availability;
DROP POLICY IF EXISTS "manager_admin_write_combo_availability" ON combo_availability;

-- Ingredients migrations (20260426000001 + 20260426000011)
DROP POLICY IF EXISTS "all_auth_select_ingredients" ON ingredients;
DROP POLICY IF EXISTS "manager_admin_write_ingredients" ON ingredients;

-- rappi_orders migration (20260417100000)
DROP POLICY IF EXISTS "rappi_orders_select_authenticated" ON rappi_orders;
DROP POLICY IF EXISTS "rappi_orders_update_authenticated" ON rappi_orders;

-- Settings migrations (20260419000001)
DROP POLICY IF EXISTS "settings_select_manager_admin" ON settings;
DROP POLICY IF EXISTS "settings_insert_manager_admin_scoped" ON settings;
DROP POLICY IF EXISTS "settings_update_manager_admin_scoped" ON settings;
DROP POLICY IF EXISTS "settings_backups_select_admin" ON settings_backups;
DROP POLICY IF EXISTS "settings_backups_insert_admin" ON settings_backups;
DROP POLICY IF EXISTS "settings_backups_update_admin" ON settings_backups;

-- caja_sessions (20260420000002) — natural language names
DROP POLICY IF EXISTS "Staff can read caja sessions" ON caja_sessions;
DROP POLICY IF EXISTS "Managers can insert caja sessions" ON caja_sessions;
DROP POLICY IF EXISTS "Managers can update caja sessions" ON caja_sessions;

-- tab_transfers + pool_table_transfers (20260420000003) — natural language names
DROP POLICY IF EXISTS "Staff can read tab transfers" ON tab_transfers;
DROP POLICY IF EXISTS "Staff can insert tab transfers" ON tab_transfers;
DROP POLICY IF EXISTS "Staff can read pool table transfers" ON pool_table_transfers;
DROP POLICY IF EXISTS "Staff can insert pool table transfers" ON pool_table_transfers;

-- caja_entries (20260421000003) — natural language names
DROP POLICY IF EXISTS "read caja entries" ON caja_entries;
DROP POLICY IF EXISTS "managers insert caja entries" ON caja_entries;
DROP POLICY IF EXISTS "managers delete caja entries" ON caja_entries;

-- Split bill / refunds (20260427000001)
DROP POLICY IF EXISTS "refunds_select_authenticated" ON refunds;
DROP POLICY IF EXISTS "refunds_insert_manager" ON refunds;
DROP POLICY IF EXISTS "refund_items_select_authenticated" ON refund_items;
DROP POLICY IF EXISTS "refund_items_insert_manager" ON refund_items;

-- Recipes (20260428000001)
DROP POLICY IF EXISTS "recipes_select_authenticated" ON recipes;
DROP POLICY IF EXISTS "recipes_write_manager" ON recipes;
DROP POLICY IF EXISTS "recipe_items_select_authenticated" ON recipe_items;
DROP POLICY IF EXISTS "recipe_items_write_manager" ON recipe_items;
DROP POLICY IF EXISTS "audit_log_insert_authenticated" ON audit_log;
DROP POLICY IF EXISTS "audit_log_select_manager" ON audit_log;

-- prep_productions (20260429000001)
DROP POLICY IF EXISTS "prep_productions_select_authenticated" ON prep_productions;
DROP POLICY IF EXISTS "prep_productions_insert_kitchen_manager" ON prep_productions;

-- Waitlist (20260501000001 + 20260501000002)
DROP POLICY IF EXISTS "waitlist_entries_select_authenticated" ON waitlist_entries;
DROP POLICY IF EXISTS "waitlist_entries_insert_manager" ON waitlist_entries;
DROP POLICY IF EXISTS "waitlist_entries_update_manager" ON waitlist_entries;
DROP POLICY IF EXISTS "waitlist_entries_delete_manager" ON waitlist_entries;
DROP POLICY IF EXISTS "waitlist_notifications_select_manager" ON waitlist_notifications;

-- Agent telemetry (20260506000001)
DROP POLICY IF EXISTS "authenticated_insert" ON pos_error_log;
DROP POLICY IF EXISTS "manager_select" ON pos_error_log;
DROP POLICY IF EXISTS "authenticated_insert" ON agent_audit_log;
DROP POLICY IF EXISTS "manager_select" ON agent_audit_log;

-- pos_codebase_index (20260506000002)
DROP POLICY IF EXISTS "authenticated_select" ON pos_codebase_index;
DROP POLICY IF EXISTS "service_insert" ON pos_codebase_index;
DROP POLICY IF EXISTS "service_delete" ON pos_codebase_index;

-- receipt_settings + pool_table_update (various migrations)
DROP POLICY IF EXISTS "pool_tables_update_bartender" ON pool_tables;
DROP POLICY IF EXISTS "receipt_settings_select_all" ON receipt_settings;
DROP POLICY IF EXISTS "receipt_settings_insert_manager_admin" ON receipt_settings;
DROP POLICY IF EXISTS "receipt_settings_update_manager_admin" ON receipt_settings;
DROP POLICY IF EXISTS "receipt_settings_delete_admin" ON receipt_settings;
*/

-- =============================================================================
-- BLOCK 2: CREATE role_permissions table + RLS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.role_permissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role       user_role NOT NULL,
  action     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, action)
);

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "role_permissions_select_authenticated" ON role_permissions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "role_permissions_write_admin" ON role_permissions
  FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- =============================================================================
-- BLOCK 3: SEED 52 rows (matches rbac.ts ROLE_SET exactly)
-- bartender: 9, manager: 17, admin: 22, kitchen: 4 = 52 total
-- =============================================================================

INSERT INTO role_permissions (role, action) VALUES
  -- bartender (9 actions)
  ('bartender', 'create_order'),
  ('bartender', 'view_own_tabs'),
  ('bartender', 'view_all_tabs'),
  ('bartender', 'start_pool_timer'),
  ('bartender', 'stop_pool_timer'),
  ('bartender', 'clock_in'),
  ('bartender', 'clock_out'),
  ('bartender', 'transfer_tab'),
  ('bartender', 'close_tab'),
  -- manager (17 actions: all bartender + 8 more from MANAGER_EXTRA)
  ('manager', 'create_order'),
  ('manager', 'view_own_tabs'),
  ('manager', 'view_all_tabs'),
  ('manager', 'start_pool_timer'),
  ('manager', 'stop_pool_timer'),
  ('manager', 'clock_in'),
  ('manager', 'clock_out'),
  ('manager', 'transfer_tab'),
  ('manager', 'close_tab'),
  ('manager', 'void_order'),
  ('manager', 'view_reports'),
  ('manager', 'adjust_inventory'),
  ('manager', 'manage_products'),
  ('manager', 'manage_caja'),
  ('manager', 'process_refund'),
  ('manager', 'produce_prep_batch'),
  ('manager', 'manage_waitlist'),
  -- admin (22 actions: all manager + 5 more from ADMIN_EXTRA)
  ('admin', 'create_order'),
  ('admin', 'view_own_tabs'),
  ('admin', 'view_all_tabs'),
  ('admin', 'start_pool_timer'),
  ('admin', 'stop_pool_timer'),
  ('admin', 'clock_in'),
  ('admin', 'clock_out'),
  ('admin', 'transfer_tab'),
  ('admin', 'close_tab'),
  ('admin', 'void_order'),
  ('admin', 'view_reports'),
  ('admin', 'adjust_inventory'),
  ('admin', 'manage_products'),
  ('admin', 'manage_caja'),
  ('admin', 'process_refund'),
  ('admin', 'produce_prep_batch'),
  ('admin', 'manage_waitlist'),
  ('admin', 'manage_staff'),
  ('admin', 'manage_settings'),
  ('admin', 'delete_tab'),
  ('admin', 'view_all_shifts'),
  ('admin', 'view_kds'),
  -- kitchen (4 actions)
  ('kitchen', 'view_kds'),
  ('kitchen', 'clock_in'),
  ('kitchen', 'clock_out'),
  ('kitchen', 'produce_prep_batch')
ON CONFLICT (role, action) DO NOTHING;

-- =============================================================================
-- BLOCK 4: CREATE ALL NEW RLS POLICIES
-- Canonical pattern: EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'X')
-- =============================================================================

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
CREATE POLICY "profiles_select_authenticated" ON profiles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "profiles_insert_admin" ON profiles
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_staff'));

CREATE POLICY "profiles_update_admin" ON profiles
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_staff'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_staff'));

CREATE POLICY "profiles_delete_admin" ON profiles
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_staff'));

-- ---------------------------------------------------------------------------
-- shifts (own-only for bartender and kitchen; manager/admin see all)
-- ---------------------------------------------------------------------------
CREATE POLICY "shifts_select_own" ON shifts
  FOR SELECT TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action IN ('clock_in', 'clock_out'))
    AND (
      get_user_role() IN ('manager', 'admin')
      OR staff_id = auth.uid()
    )
  );

CREATE POLICY "shifts_insert_own" ON shifts
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'clock_in')
    AND staff_id = auth.uid()
  );

CREATE POLICY "shifts_insert_manager_admin" ON shifts
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "shifts_update_own" ON shifts
  FOR UPDATE TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'clock_out')
    AND staff_id = auth.uid()
  )
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'clock_out')
    AND staff_id = auth.uid()
  );

CREATE POLICY "shifts_update_manager_admin" ON shifts
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "shifts_delete_admin" ON shifts
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- categories (kitchen can SELECT)
-- ---------------------------------------------------------------------------
CREATE POLICY "categories_select_authenticated" ON categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "categories_insert_manager_admin" ON categories
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "categories_update_manager_admin" ON categories
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "categories_delete_manager_admin" ON categories
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

-- ---------------------------------------------------------------------------
-- products (kitchen can SELECT)
-- ---------------------------------------------------------------------------
CREATE POLICY "products_select_authenticated" ON products
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "products_insert_manager_admin" ON products
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "products_update_manager_admin" ON products
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "products_delete_manager_admin" ON products
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

-- ---------------------------------------------------------------------------
-- modifiers (legacy — SELECT-all, write manager+)
-- ---------------------------------------------------------------------------
CREATE POLICY "modifiers_select_authenticated" ON modifiers
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "modifiers_insert_manager_admin" ON modifiers
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "modifiers_update_manager_admin" ON modifiers
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "modifiers_delete_manager_admin" ON modifiers
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- product_modifiers (legacy — SELECT-all, write manager+)
-- ---------------------------------------------------------------------------
CREATE POLICY "product_modifiers_select_authenticated" ON product_modifiers
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "product_modifiers_insert_manager_admin" ON product_modifiers
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "product_modifiers_delete_manager_admin" ON product_modifiers
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- tabs (bartender SELECT+insert+update; kitchen SELECT; is_deleted filter)
-- ---------------------------------------------------------------------------
CREATE POLICY "tabs_select_bartender" ON tabs
  FOR SELECT TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'view_all_tabs')
    AND is_deleted = FALSE
  );

CREATE POLICY "tabs_select_kitchen" ON tabs
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'kitchen' AND is_deleted = FALSE
  );

CREATE POLICY "tabs_insert_bartender" ON tabs
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'create_order')
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "tabs_update_bartender" ON tabs
  FOR UPDATE TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'close_tab')
    AND is_deleted = FALSE
    AND get_user_role() != 'kitchen'
  )
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'close_tab')
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "tabs_delete_admin" ON tabs
  FOR DELETE TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'delete_tab')
  );

-- ---------------------------------------------------------------------------
-- orders (bartender SELECT+insert; kitchen SELECT; is_deleted filter)
-- ---------------------------------------------------------------------------
CREATE POLICY "orders_select_bartender" ON orders
  FOR SELECT TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'view_all_tabs')
    AND is_deleted = FALSE
  );

CREATE POLICY "orders_select_kitchen" ON orders
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'kitchen' AND is_deleted = FALSE
  );

CREATE POLICY "orders_insert_bartender" ON orders
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'create_order')
    AND get_user_role() != 'kitchen'
    AND staff_id = auth.uid()
  );

CREATE POLICY "orders_insert_manager_admin" ON orders
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "orders_update_manager_admin" ON orders
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE)
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "orders_delete_manager_admin" ON orders
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- order_items (bartender SELECT+insert+delete; kitchen SELECT+update for kds_status)
-- ---------------------------------------------------------------------------
CREATE POLICY "order_items_select_bartender" ON order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'view_all_tabs')
    AND is_deleted = FALSE
  );

CREATE POLICY "order_items_select_kitchen" ON order_items
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'kitchen' AND is_deleted = FALSE
  );

CREATE POLICY "order_items_insert_bartender" ON order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'create_order')
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "order_items_insert_manager_admin" ON order_items
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "order_items_update_manager_admin" ON order_items
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE)
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "order_items_update_kitchen" ON order_items
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'kitchen' AND is_deleted = FALSE)
  WITH CHECK (get_user_role() = 'kitchen');

CREATE POLICY "order_items_delete_manager_admin" ON order_items
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- pool_tables (all authenticated SELECT; bartender UPDATE; manager+ write)
-- ---------------------------------------------------------------------------
CREATE POLICY "pool_tables_select_authenticated" ON pool_tables
  FOR SELECT TO authenticated
  USING (is_deleted = FALSE);

CREATE POLICY "pool_tables_update_bartender" ON pool_tables
  FOR UPDATE TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'start_pool_timer')
    AND is_deleted = FALSE
    AND get_user_role() != 'kitchen'
  )
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'start_pool_timer')
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "pool_tables_insert_manager_admin" ON pool_tables
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "pool_tables_update_manager_admin" ON pool_tables
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "pool_tables_delete_manager_admin" ON pool_tables
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- pool_sessions (bartender SELECT+insert+update; manager+ all)
-- ---------------------------------------------------------------------------
CREATE POLICY "pool_sessions_select_bartender" ON pool_sessions
  FOR SELECT TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'start_pool_timer')
    AND is_deleted = FALSE
  );

CREATE POLICY "pool_sessions_select_manager_admin" ON pool_sessions
  FOR SELECT TO authenticated
  USING (
    get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE
  );

CREATE POLICY "pool_sessions_insert_bartender" ON pool_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'start_pool_timer')
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "pool_sessions_insert_manager_admin" ON pool_sessions
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "pool_sessions_update_bartender" ON pool_sessions
  FOR UPDATE TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'stop_pool_timer')
    AND is_deleted = FALSE
    AND get_user_role() != 'kitchen'
  )
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'stop_pool_timer')
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "pool_sessions_update_manager_admin" ON pool_sessions
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "pool_sessions_delete_manager_admin" ON pool_sessions
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- payments (bartender SELECT; manager SELECT+insert; admin full)
-- ---------------------------------------------------------------------------
CREATE POLICY "payments_select_bartender" ON payments
  FOR SELECT TO authenticated
  USING (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'close_tab')
    AND is_deleted = FALSE
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "payments_select_manager_admin" ON payments
  FOR SELECT TO authenticated
  USING (
    get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE
  );

CREATE POLICY "payments_insert_manager_admin" ON payments
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "payments_update_admin" ON payments
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "payments_delete_admin" ON payments
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- inventory (all authenticated SELECT; manager+ write; admin delete)
-- ---------------------------------------------------------------------------
CREATE POLICY "inventory_select_authenticated" ON inventory
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "inventory_insert_manager_admin" ON inventory
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'adjust_inventory'));

CREATE POLICY "inventory_update_manager_admin" ON inventory
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'adjust_inventory'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'adjust_inventory'));

CREATE POLICY "inventory_delete_admin" ON inventory
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- stock_movements (manager+ read/write; kitchen SELECT per D-08)
-- ---------------------------------------------------------------------------
CREATE POLICY "stock_movements_select_manager_admin" ON stock_movements
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "stock_movements_select_kitchen" ON stock_movements
  FOR SELECT TO authenticated
  USING (get_user_role() = 'kitchen');

CREATE POLICY "stock_movements_insert_manager_admin" ON stock_movements
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'adjust_inventory'));

CREATE POLICY "stock_movements_delete_admin" ON stock_movements
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- modifier_groups, modifier_group_items, product_modifier_groups
-- ---------------------------------------------------------------------------
CREATE POLICY "modifier_groups_select_authenticated" ON modifier_groups
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "modifier_groups_insert_manager_admin" ON modifier_groups
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "modifier_groups_update_manager_admin" ON modifier_groups
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "modifier_groups_delete_manager_admin" ON modifier_groups
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "modifier_group_items_select_authenticated" ON modifier_group_items
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "modifier_group_items_insert_manager_admin" ON modifier_group_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "modifier_group_items_update_manager_admin" ON modifier_group_items
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "modifier_group_items_delete_manager_admin" ON modifier_group_items
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "product_modifier_groups_select_authenticated" ON product_modifier_groups
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "product_modifier_groups_insert_manager_admin" ON product_modifier_groups
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "product_modifier_groups_update_manager_admin" ON product_modifier_groups
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "product_modifier_groups_delete_manager_admin" ON product_modifier_groups
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- combo_slots, combo_slot_options, combo_availability
-- (separated policies per Risk 3 — no combined ALL policy)
-- ---------------------------------------------------------------------------
CREATE POLICY "combo_slots_select_authenticated" ON combo_slots
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "combo_slots_insert_manager_admin" ON combo_slots
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "combo_slots_update_manager_admin" ON combo_slots
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "combo_slots_delete_manager_admin" ON combo_slots
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "combo_slot_options_select_authenticated" ON combo_slot_options
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "combo_slot_options_insert_manager_admin" ON combo_slot_options
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "combo_slot_options_update_manager_admin" ON combo_slot_options
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "combo_slot_options_delete_manager_admin" ON combo_slot_options
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "combo_availability_select_authenticated" ON combo_availability
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "combo_availability_insert_manager_admin" ON combo_availability
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "combo_availability_update_manager_admin" ON combo_availability
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "combo_availability_delete_manager_admin" ON combo_availability
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

-- ---------------------------------------------------------------------------
-- ingredients (all authenticated + kitchen SELECT; manager+ write)
-- ---------------------------------------------------------------------------
CREATE POLICY "ingredients_select_authenticated" ON ingredients
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "ingredients_insert_manager_admin" ON ingredients
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "ingredients_update_manager_admin" ON ingredients
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "ingredients_delete_manager_admin" ON ingredients
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- recipes, recipe_items
-- ---------------------------------------------------------------------------
CREATE POLICY "recipes_select_authenticated" ON recipes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "recipes_insert_manager_admin" ON recipes
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "recipes_update_manager_admin" ON recipes
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "recipes_delete_manager_admin" ON recipes
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "recipe_items_select_authenticated" ON recipe_items
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "recipe_items_insert_manager_admin" ON recipe_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "recipe_items_update_manager_admin" ON recipe_items
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "recipe_items_delete_manager_admin" ON recipe_items
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- prep_productions (kitchen + manager+ SELECT; kitchen + manager+ INSERT; admin delete)
-- ---------------------------------------------------------------------------
CREATE POLICY "prep_productions_select_authenticated" ON prep_productions
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin', 'kitchen'));

CREATE POLICY "prep_productions_insert_kitchen_manager" ON prep_productions
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'produce_prep_batch'));

CREATE POLICY "prep_productions_delete_admin" ON prep_productions
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- rappi_orders (bartender+ SELECT+update; manager+ write; per Risk 7)
-- Replaces broken tenant_id check with bartender+ role guard
-- ---------------------------------------------------------------------------
CREATE POLICY "rappi_orders_select_bartender" ON rappi_orders
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "rappi_orders_update_bartender" ON rappi_orders
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'))
  WITH CHECK (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "rappi_orders_insert_admin" ON rappi_orders
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "rappi_orders_delete_admin" ON rappi_orders
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- settings, settings_backups
-- ---------------------------------------------------------------------------
CREATE POLICY "settings_select_manager_admin" ON settings
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "settings_insert_admin" ON settings
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_settings'));

CREATE POLICY "settings_update_admin" ON settings
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_settings'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_settings'));

CREATE POLICY "settings_delete_admin" ON settings
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_settings'));

CREATE POLICY "settings_backups_select_admin" ON settings_backups
  FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "settings_backups_insert_admin" ON settings_backups
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "settings_backups_update_admin" ON settings_backups
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- receipt_settings (all authenticated SELECT; manager+ write) — guarded
-- ---------------------------------------------------------------------------
-- Table may not exist on all environments. Skip block if missing.
DO $rs$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'receipt_settings') THEN
    EXECUTE $cp$CREATE POLICY "receipt_settings_select_authenticated" ON receipt_settings FOR SELECT TO authenticated USING (true)$cp$;
    EXECUTE $cp$CREATE POLICY "receipt_settings_insert_admin" ON receipt_settings FOR INSERT TO authenticated WITH CHECK (get_user_role() IN ('manager', 'admin'))$cp$;
    EXECUTE $cp$CREATE POLICY "receipt_settings_update_admin" ON receipt_settings FOR UPDATE TO authenticated USING (get_user_role() IN ('manager', 'admin')) WITH CHECK (get_user_role() IN ('manager', 'admin'))$cp$;
    EXECUTE $cp$CREATE POLICY "receipt_settings_delete_admin" ON receipt_settings FOR DELETE TO authenticated USING (get_user_role() = 'admin')$cp$;
  END IF;
END
$rs$;

-- ---------------------------------------------------------------------------
-- caja_sessions, caja_entries
-- ---------------------------------------------------------------------------
CREATE POLICY "caja_sessions_select_authenticated" ON caja_sessions
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "caja_sessions_insert_manager_admin" ON caja_sessions
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_caja'));

CREATE POLICY "caja_sessions_update_manager_admin" ON caja_sessions
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_caja'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_caja'));

CREATE POLICY "caja_sessions_delete_admin" ON caja_sessions
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "caja_entries_select_authenticated" ON caja_entries
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "caja_entries_insert_manager_admin" ON caja_entries
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_caja'));

CREATE POLICY "caja_entries_delete_manager_admin" ON caja_entries
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_caja'));

-- ---------------------------------------------------------------------------
-- tab_transfers, pool_table_transfers
-- ---------------------------------------------------------------------------
CREATE POLICY "tab_transfers_select_authenticated" ON tab_transfers
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "tab_transfers_insert_bartender" ON tab_transfers
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'transfer_tab')
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "tab_transfers_delete_admin" ON tab_transfers
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "pool_table_transfers_select_authenticated" ON pool_table_transfers
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "pool_table_transfers_insert_bartender" ON pool_table_transfers
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'stop_pool_timer')
    AND get_user_role() != 'kitchen'
  );

CREATE POLICY "pool_table_transfers_delete_admin" ON pool_table_transfers
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- refunds, refund_items
-- ---------------------------------------------------------------------------
CREATE POLICY "refunds_select_authenticated" ON refunds
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "refunds_insert_manager_admin" ON refunds
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'process_refund'));

CREATE POLICY "refunds_update_admin" ON refunds
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "refund_items_select_authenticated" ON refund_items
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "refund_items_insert_manager_admin" ON refund_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'process_refund'));

-- ---------------------------------------------------------------------------
-- audit_log (CRITICAL: INSERT must remain open — SECURITY DEFINER RPCs need
-- authenticated INSERT; see Risk 4 / threat T-13-06)
-- ---------------------------------------------------------------------------
CREATE POLICY "audit_log_insert_authenticated" ON audit_log
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "audit_log_select_manager_admin" ON audit_log
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- waitlist_entries, waitlist_notifications
-- ---------------------------------------------------------------------------
CREATE POLICY "waitlist_entries_select_authenticated" ON waitlist_entries
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('bartender', 'manager', 'admin'));

CREATE POLICY "waitlist_entries_insert_manager_admin" ON waitlist_entries
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_waitlist'));

CREATE POLICY "waitlist_entries_update_manager_admin" ON waitlist_entries
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_waitlist'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_waitlist'));

CREATE POLICY "waitlist_entries_delete_manager_admin" ON waitlist_entries
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_waitlist'));

CREATE POLICY "waitlist_notifications_select_manager_admin" ON waitlist_notifications
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ---------------------------------------------------------------------------
-- pos_error_log, agent_audit_log (admin-only SELECT; authenticated INSERT)
-- ---------------------------------------------------------------------------
CREATE POLICY "pos_error_log_insert_authenticated" ON pos_error_log
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "pos_error_log_select_admin" ON pos_error_log
  FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "agent_audit_log_insert_authenticated" ON agent_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "agent_audit_log_select_admin" ON agent_audit_log
  FOR SELECT TO authenticated
  USING (get_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- pos_codebase_index (service_role INSERT/DELETE; authenticated SELECT)
-- ---------------------------------------------------------------------------
CREATE POLICY "pos_codebase_index_select_authenticated" ON pos_codebase_index
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "pos_codebase_index_insert_service" ON pos_codebase_index
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "pos_codebase_index_delete_service" ON pos_codebase_index
  FOR DELETE TO service_role USING (true);

-- =============================================================================
-- BLOCK 5: DOWN
-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS role_permissions CASCADE;
-- -- To restore original policies, re-apply:
-- -- bar-pos/supabase/migrations/20260414000009_rls_policies.sql
-- -- bar-pos/supabase/migrations/20260420000006_rls_updates.sql
-- -- bar-pos/supabase/migrations/20260507000001_fix_combo_rls.sql
-- -- (and all subsequent patch migrations)
-- COMMIT;

COMMIT;
