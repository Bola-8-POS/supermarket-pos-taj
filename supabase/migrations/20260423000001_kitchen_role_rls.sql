-- Allow kitchen role to SELECT, INSERT, and UPDATE their own shifts
-- (needed for clock-in / clock-out workflow, same as bartender)

CREATE POLICY "shifts_select_kitchen" ON shifts
  FOR SELECT
  TO authenticated
  USING (
    get_user_role() = 'kitchen' AND staff_id = auth.uid()
  );

CREATE POLICY "shifts_insert_kitchen" ON shifts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    get_user_role() = 'kitchen' AND staff_id = auth.uid()
  );

CREATE POLICY "shifts_update_kitchen" ON shifts
  FOR UPDATE
  TO authenticated
  USING (
    get_user_role() = 'kitchen' AND staff_id = auth.uid()
  )
  WITH CHECK (
    get_user_role() = 'kitchen' AND staff_id = auth.uid()
  );

-- Allow kitchen role to SELECT order_items (needed for KDS board query)
CREATE POLICY "order_items_select_kitchen" ON order_items
  FOR SELECT
  TO authenticated
  USING (get_user_role() = 'kitchen');

-- Allow kitchen role to UPDATE order_items (needed for bump kds_status)
CREATE POLICY "order_items_update_kitchen" ON order_items
  FOR UPDATE
  TO authenticated
  USING (get_user_role() = 'kitchen')
  WITH CHECK (get_user_role() = 'kitchen');

-- Allow kitchen role to SELECT orders (needed for KDS join query)
CREATE POLICY "orders_select_kitchen" ON orders
  FOR SELECT
  TO authenticated
  USING (get_user_role() = 'kitchen');

-- Allow kitchen role to SELECT tabs (needed for KDS join query)
CREATE POLICY "tabs_select_kitchen" ON tabs
  FOR SELECT
  TO authenticated
  USING (get_user_role() = 'kitchen');

-- Allow kitchen role to SELECT products and categories (needed for KDS join query)
CREATE POLICY "products_select_kitchen" ON products
  FOR SELECT
  TO authenticated
  USING (get_user_role() = 'kitchen');

CREATE POLICY "categories_select_kitchen" ON categories
  FOR SELECT
  TO authenticated
  USING (get_user_role() = 'kitchen');
