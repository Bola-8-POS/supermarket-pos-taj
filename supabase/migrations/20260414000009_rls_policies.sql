-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pool_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE pool_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_log ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- HELPER FUNCTION: Get current user's role
-- =====================================================
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS user_role AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- =====================================================
-- PROFILES
-- =====================================================
-- All authenticated users can read all profiles
CREATE POLICY "profiles_select_all" ON profiles
  FOR SELECT
  TO authenticated
  USING (true);

-- Only admins can insert/update/delete profiles
CREATE POLICY "profiles_insert_admin" ON profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "profiles_update_admin" ON profiles
  FOR UPDATE
  TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "profiles_delete_admin" ON profiles
  FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');

-- =====================================================
-- SHIFTS
-- =====================================================
-- Bartenders can SELECT their own shifts
CREATE POLICY "shifts_select_bartender" ON shifts
  FOR SELECT
  TO authenticated
  USING (
    get_user_role() = 'bartender' AND staff_id = auth.uid()
  );

-- Managers and admins can SELECT all shifts
CREATE POLICY "shifts_select_manager_admin" ON shifts
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Bartenders can INSERT their own shifts (clock in)
CREATE POLICY "shifts_insert_bartender" ON shifts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    get_user_role() = 'bartender' AND staff_id = auth.uid()
  );

-- Managers and admins can INSERT any shift
CREATE POLICY "shifts_insert_manager_admin" ON shifts
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Bartenders can UPDATE their own shifts (clock out)
CREATE POLICY "shifts_update_bartender" ON shifts
  FOR UPDATE
  TO authenticated
  USING (
    get_user_role() = 'bartender' AND staff_id = auth.uid()
  )
  WITH CHECK (
    get_user_role() = 'bartender' AND staff_id = auth.uid()
  );

-- Managers and admins can UPDATE any shift
CREATE POLICY "shifts_update_manager_admin" ON shifts
  FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Only admins can DELETE shifts
CREATE POLICY "shifts_delete_admin" ON shifts
  FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');

-- =====================================================
-- CATEGORIES, PRODUCTS, MODIFIERS, PRODUCT_MODIFIERS
-- =====================================================
-- All authenticated users can SELECT
CREATE POLICY "categories_select_all" ON categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "products_select_all" ON products
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "modifiers_select_all" ON modifiers
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "product_modifiers_select_all" ON product_modifiers
  FOR SELECT TO authenticated USING (true);

-- Only managers and admins can INSERT/UPDATE/DELETE
CREATE POLICY "categories_insert_manager_admin" ON categories
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "categories_update_manager_admin" ON categories
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "categories_delete_manager_admin" ON categories
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "products_insert_manager_admin" ON products
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "products_update_manager_admin" ON products
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "products_delete_manager_admin" ON products
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

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

CREATE POLICY "product_modifiers_insert_manager_admin" ON product_modifiers
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "product_modifiers_delete_manager_admin" ON product_modifiers
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- =====================================================
-- TABS
-- =====================================================
-- Bartenders can SELECT tabs from their own shifts
CREATE POLICY "tabs_select_bartender" ON tabs
  FOR SELECT
  TO authenticated
  USING (
    get_user_role() = 'bartender' AND 
    shift_id IN (SELECT id FROM shifts WHERE staff_id = auth.uid())
  );

-- Managers and admins can SELECT all tabs
CREATE POLICY "tabs_select_manager_admin" ON tabs
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Bartenders can INSERT tabs during their own shifts
CREATE POLICY "tabs_insert_bartender" ON tabs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    get_user_role() = 'bartender' AND
    shift_id IN (SELECT id FROM shifts WHERE staff_id = auth.uid() AND clock_out IS NULL)
  );

-- Managers and admins can INSERT any tab
CREATE POLICY "tabs_insert_manager_admin" ON tabs
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can UPDATE tabs
CREATE POLICY "tabs_update_manager_admin" ON tabs
  FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can DELETE tabs
CREATE POLICY "tabs_delete_manager_admin" ON tabs
  FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- =====================================================
-- ORDERS
-- =====================================================
-- Bartenders can SELECT orders from their own shifts
CREATE POLICY "orders_select_bartender" ON orders
  FOR SELECT
  TO authenticated
  USING (
    get_user_role() = 'bartender' AND
    tab_id IN (
      SELECT id FROM tabs WHERE shift_id IN (
        SELECT id FROM shifts WHERE staff_id = auth.uid()
      )
    )
  );

-- Managers and admins can SELECT all orders
CREATE POLICY "orders_select_manager_admin" ON orders
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Bartenders can INSERT orders on tabs from their own shifts
CREATE POLICY "orders_insert_bartender" ON orders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    get_user_role() = 'bartender' AND
    staff_id = auth.uid() AND
    tab_id IN (
      SELECT id FROM tabs WHERE shift_id IN (
        SELECT id FROM shifts WHERE staff_id = auth.uid() AND clock_out IS NULL
      )
    )
  );

-- Managers and admins can INSERT any order
CREATE POLICY "orders_insert_manager_admin" ON orders
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can UPDATE orders
CREATE POLICY "orders_update_manager_admin" ON orders
  FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can DELETE orders
CREATE POLICY "orders_delete_manager_admin" ON orders
  FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- =====================================================
-- ORDER_ITEMS
-- =====================================================
-- Bartenders can SELECT order items from their own shifts
CREATE POLICY "order_items_select_bartender" ON order_items
  FOR SELECT
  TO authenticated
  USING (
    get_user_role() = 'bartender' AND
    order_id IN (
      SELECT o.id FROM orders o
      JOIN tabs t ON o.tab_id = t.id
      WHERE t.shift_id IN (
        SELECT id FROM shifts WHERE staff_id = auth.uid()
      )
    )
  );

-- Managers and admins can SELECT all order items
CREATE POLICY "order_items_select_manager_admin" ON order_items
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Bartenders can INSERT order items on orders from their own shifts
CREATE POLICY "order_items_insert_bartender" ON order_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    get_user_role() = 'bartender' AND
    order_id IN (
      SELECT o.id FROM orders o
      JOIN tabs t ON o.tab_id = t.id
      WHERE t.shift_id IN (
        SELECT id FROM shifts WHERE staff_id = auth.uid() AND clock_out IS NULL
      )
    )
  );

-- Managers and admins can INSERT any order item
CREATE POLICY "order_items_insert_manager_admin" ON order_items
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can UPDATE order items
CREATE POLICY "order_items_update_manager_admin" ON order_items
  FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can DELETE order items
CREATE POLICY "order_items_delete_manager_admin" ON order_items
  FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- =====================================================
-- POOL_TABLES
-- =====================================================
-- All authenticated users can SELECT pool tables
CREATE POLICY "pool_tables_select_all" ON pool_tables
  FOR SELECT TO authenticated USING (true);

-- Managers and admins can INSERT/UPDATE/DELETE pool tables
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

-- =====================================================
-- POOL_SESSIONS
-- =====================================================
-- Bartenders can SELECT pool sessions from their own shifts
CREATE POLICY "pool_sessions_select_bartender" ON pool_sessions
  FOR SELECT
  TO authenticated
  USING (
    get_user_role() = 'bartender' AND
    (tab_id IS NULL OR tab_id IN (
      SELECT id FROM tabs WHERE shift_id IN (
        SELECT id FROM shifts WHERE staff_id = auth.uid()
      )
    ))
  );

-- Managers and admins can SELECT all pool sessions
CREATE POLICY "pool_sessions_select_manager_admin" ON pool_sessions
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Bartenders can INSERT pool sessions on tabs from their own shifts
CREATE POLICY "pool_sessions_insert_bartender" ON pool_sessions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    get_user_role() = 'bartender' AND
    (tab_id IS NULL OR tab_id IN (
      SELECT id FROM tabs WHERE shift_id IN (
        SELECT id FROM shifts WHERE staff_id = auth.uid() AND clock_out IS NULL
      )
    ))
  );

-- Managers and admins can INSERT any pool session
CREATE POLICY "pool_sessions_insert_manager_admin" ON pool_sessions
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Bartenders can UPDATE pool sessions on tabs from their own shifts
CREATE POLICY "pool_sessions_update_bartender" ON pool_sessions
  FOR UPDATE
  TO authenticated
  USING (
    get_user_role() = 'bartender' AND
    (tab_id IS NULL OR tab_id IN (
      SELECT id FROM tabs WHERE shift_id IN (
        SELECT id FROM shifts WHERE staff_id = auth.uid()
      )
    ))
  )
  WITH CHECK (
    get_user_role() = 'bartender' AND
    (tab_id IS NULL OR tab_id IN (
      SELECT id FROM tabs WHERE shift_id IN (
        SELECT id FROM shifts WHERE staff_id = auth.uid()
      )
    ))
  );

-- Managers and admins can UPDATE any pool session
CREATE POLICY "pool_sessions_update_manager_admin" ON pool_sessions
  FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can DELETE pool sessions
CREATE POLICY "pool_sessions_delete_manager_admin" ON pool_sessions
  FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- =====================================================
-- PAYMENTS
-- =====================================================
-- Managers and admins can SELECT all payments
CREATE POLICY "payments_select_manager_admin" ON payments
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can INSERT payments
CREATE POLICY "payments_insert_manager_admin" ON payments
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Only admins can UPDATE payments
CREATE POLICY "payments_update_admin" ON payments
  FOR UPDATE
  TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- Only admins can DELETE payments
CREATE POLICY "payments_delete_admin" ON payments
  FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');

-- =====================================================
-- INVENTORY
-- =====================================================
-- All authenticated users can SELECT inventory
CREATE POLICY "inventory_select_all" ON inventory
  FOR SELECT TO authenticated USING (true);

-- Managers and admins can INSERT/UPDATE inventory
CREATE POLICY "inventory_insert_manager_admin" ON inventory
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "inventory_update_manager_admin" ON inventory
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Only admins can DELETE inventory
CREATE POLICY "inventory_delete_admin" ON inventory
  FOR DELETE TO authenticated
  USING (get_user_role() = 'admin');

-- =====================================================
-- INVENTORY_LOG
-- =====================================================
-- Managers and admins can SELECT all inventory logs
CREATE POLICY "inventory_log_select_manager_admin" ON inventory_log
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can INSERT inventory logs
CREATE POLICY "inventory_log_insert_manager_admin" ON inventory_log
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Only admins can DELETE inventory logs
CREATE POLICY "inventory_log_delete_admin" ON inventory_log
  FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');
