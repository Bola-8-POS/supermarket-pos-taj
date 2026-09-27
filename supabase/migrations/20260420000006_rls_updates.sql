-- ============================================================================
-- RLS UPDATES
-- 1. All staff (bartender included) can see ALL open tabs — not just own-shift.
-- 2. All staff can see all orders / order_items / pool_sessions (any open tab).
-- 3. Soft-delete: is_deleted=FALSE filter added to all SELECT policies.
-- ============================================================================

-- ============================================================================
-- TABS — bartenders see all tabs (not restricted to own shift)
-- ============================================================================
DROP POLICY IF EXISTS "tabs_select_bartender" ON tabs;
CREATE POLICY "tabs_select_bartender" ON tabs
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'bartender' AND is_deleted = FALSE
  );

DROP POLICY IF EXISTS "tabs_select_manager_admin" ON tabs;
CREATE POLICY "tabs_select_manager_admin" ON tabs
  FOR SELECT TO authenticated
  USING (
    get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE
  );

-- Allow bartenders to UPDATE tabs they are operating (for transfers, status changes)
DROP POLICY IF EXISTS "tabs_update_bartender" ON tabs;
CREATE POLICY "tabs_update_bartender" ON tabs
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'bartender' AND is_deleted = FALSE)
  WITH CHECK (get_user_role() = 'bartender');

-- ============================================================================
-- ORDERS — bartenders see all orders on any tab
-- ============================================================================
DROP POLICY IF EXISTS "orders_select_bartender" ON orders;
CREATE POLICY "orders_select_bartender" ON orders
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'bartender' AND is_deleted = FALSE
  );

DROP POLICY IF EXISTS "orders_select_manager_admin" ON orders;
CREATE POLICY "orders_select_manager_admin" ON orders
  FOR SELECT TO authenticated
  USING (
    get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE
  );

-- Allow bartenders to INSERT orders on any open tab
DROP POLICY IF EXISTS "orders_insert_bartender" ON orders;
CREATE POLICY "orders_insert_bartender" ON orders
  FOR INSERT TO authenticated
  WITH CHECK (
    get_user_role() = 'bartender' AND staff_id = auth.uid()
  );

-- ============================================================================
-- ORDER_ITEMS — bartenders see all order items
-- ============================================================================
DROP POLICY IF EXISTS "order_items_select_bartender" ON order_items;
CREATE POLICY "order_items_select_bartender" ON order_items
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'bartender' AND is_deleted = FALSE
  );

DROP POLICY IF EXISTS "order_items_select_manager_admin" ON order_items;
CREATE POLICY "order_items_select_manager_admin" ON order_items
  FOR SELECT TO authenticated
  USING (
    get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE
  );

-- Allow bartenders to INSERT order items on any open tab's order
DROP POLICY IF EXISTS "order_items_insert_bartender" ON order_items;
CREATE POLICY "order_items_insert_bartender" ON order_items
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() = 'bartender');

-- ============================================================================
-- POOL_SESSIONS — bartenders see all pool sessions
-- ============================================================================
DROP POLICY IF EXISTS "pool_sessions_select_bartender" ON pool_sessions;
CREATE POLICY "pool_sessions_select_bartender" ON pool_sessions
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'bartender' AND is_deleted = FALSE
  );

DROP POLICY IF EXISTS "pool_sessions_select_manager_admin" ON pool_sessions;
CREATE POLICY "pool_sessions_select_manager_admin" ON pool_sessions
  FOR SELECT TO authenticated
  USING (
    get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE
  );

-- Allow bartenders to INSERT pool sessions on any tab
DROP POLICY IF EXISTS "pool_sessions_insert_bartender" ON pool_sessions;
CREATE POLICY "pool_sessions_insert_bartender" ON pool_sessions
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() = 'bartender');

-- Allow bartenders to UPDATE any pool session (start/stop timer)
DROP POLICY IF EXISTS "pool_sessions_update_bartender" ON pool_sessions;
CREATE POLICY "pool_sessions_update_bartender" ON pool_sessions
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'bartender' AND is_deleted = FALSE)
  WITH CHECK (get_user_role() = 'bartender');

-- ============================================================================
-- PAYMENTS — add is_deleted filter
-- ============================================================================
DROP POLICY IF EXISTS "payments_select_manager_admin" ON payments;
CREATE POLICY "payments_select_manager_admin" ON payments
  FOR SELECT TO authenticated
  USING (
    get_user_role() IN ('manager', 'admin') AND is_deleted = FALSE
  );

-- Bartenders can see payments on tabs they're operating
CREATE POLICY "payments_select_bartender" ON payments
  FOR SELECT TO authenticated
  USING (
    get_user_role() = 'bartender' AND is_deleted = FALSE
  );

-- ============================================================================
-- POOL_TABLES — add is_deleted filter
-- ============================================================================
DROP POLICY IF EXISTS "pool_tables_select_all" ON pool_tables;
CREATE POLICY "pool_tables_select_all" ON pool_tables
  FOR SELECT TO authenticated
  USING (is_deleted = FALSE);
