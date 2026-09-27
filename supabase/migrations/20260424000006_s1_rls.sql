-- =============================================================================
-- S1-11: Row Level Security policies for S1 new tables
-- Tables: modifier_groups, modifier_group_items, product_modifier_groups
-- Policy intent:
--   - All authenticated users can SELECT (read catalog data for POS)
--   - Managers and admins can INSERT/UPDATE/DELETE (manage catalog)
--   - Bartenders: read-only on all three tables
-- Pattern matches existing inventory policies in 20260414000009_rls_policies.sql
-- =============================================================================

BEGIN;

-- Enable RLS on new tables
ALTER TABLE modifier_groups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_group_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_modifier_groups ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- modifier_groups
-- ============================================================================

-- All authenticated users can read modifier groups
CREATE POLICY "modifier_groups_select_all" ON modifier_groups
  FOR SELECT
  TO authenticated
  USING (true);

-- Only managers and admins can write modifier groups (bartender: read-only)
CREATE POLICY "modifier_groups_insert_manager_admin" ON modifier_groups
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "modifier_groups_update_manager_admin" ON modifier_groups
  FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "modifier_groups_delete_manager_admin" ON modifier_groups
  FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ============================================================================
-- modifier_group_items
-- ============================================================================

-- All authenticated users can read modifier group items
CREATE POLICY "modifier_group_items_select_all" ON modifier_group_items
  FOR SELECT
  TO authenticated
  USING (true);

-- Only managers and admins can write modifier group items
CREATE POLICY "modifier_group_items_insert_manager_admin" ON modifier_group_items
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "modifier_group_items_update_manager_admin" ON modifier_group_items
  FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "modifier_group_items_delete_manager_admin" ON modifier_group_items
  FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ============================================================================
-- product_modifier_groups
-- ============================================================================

-- All authenticated users can read product-modifier-group associations
CREATE POLICY "product_modifier_groups_select_all" ON product_modifier_groups
  FOR SELECT
  TO authenticated
  USING (true);

-- Only managers and admins can write product-modifier-group associations
CREATE POLICY "product_modifier_groups_insert_manager_admin" ON product_modifier_groups
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "product_modifier_groups_update_manager_admin" ON product_modifier_groups
  FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "product_modifier_groups_delete_manager_admin" ON product_modifier_groups
  FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP POLICY IF EXISTS "product_modifier_groups_delete_manager_admin" ON product_modifier_groups;
-- DROP POLICY IF EXISTS "product_modifier_groups_update_manager_admin" ON product_modifier_groups;
-- DROP POLICY IF EXISTS "product_modifier_groups_insert_manager_admin" ON product_modifier_groups;
-- DROP POLICY IF EXISTS "product_modifier_groups_select_all"            ON product_modifier_groups;
-- DROP POLICY IF EXISTS "modifier_group_items_delete_manager_admin"     ON modifier_group_items;
-- DROP POLICY IF EXISTS "modifier_group_items_update_manager_admin"     ON modifier_group_items;
-- DROP POLICY IF EXISTS "modifier_group_items_insert_manager_admin"     ON modifier_group_items;
-- DROP POLICY IF EXISTS "modifier_group_items_select_all"               ON modifier_group_items;
-- DROP POLICY IF EXISTS "modifier_groups_delete_manager_admin"          ON modifier_groups;
-- DROP POLICY IF EXISTS "modifier_groups_update_manager_admin"          ON modifier_groups;
-- DROP POLICY IF EXISTS "modifier_groups_insert_manager_admin"          ON modifier_groups;
-- DROP POLICY IF EXISTS "modifier_groups_select_all"                    ON modifier_groups;
-- ALTER TABLE product_modifier_groups DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE modifier_group_items    DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE modifier_groups         DISABLE ROW LEVEL SECURITY;
-- COMMIT;
-- =============================================================================
