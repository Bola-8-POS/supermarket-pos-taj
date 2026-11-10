-- Kitchen role removal (D29), step 2 of 4: RLS.
-- Drops the 5 kitchen-only policies; redefines the 5 *_bartender policies exactly as live
-- on dev2 minus the `get_user_role() <> 'kitchen'` clause (name, command, roles unchanged).

DROP POLICY IF EXISTS order_items_select_kitchen ON public.order_items;
DROP POLICY IF EXISTS order_items_update_kitchen ON public.order_items;
DROP POLICY IF EXISTS orders_select_kitchen ON public.orders;
DROP POLICY IF EXISTS tabs_select_kitchen ON public.tabs;
DROP POLICY IF EXISTS stock_movements_select_kitchen ON public.stock_movements;

DROP POLICY IF EXISTS tabs_insert_bartender ON public.tabs;
CREATE POLICY tabs_insert_bartender ON public.tabs AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions
    WHERE role_permissions.role = get_user_role() AND role_permissions.action = 'create_order'));

DROP POLICY IF EXISTS tabs_update_bartender ON public.tabs;
CREATE POLICY tabs_update_bartender ON public.tabs AS PERMISSIVE FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM role_permissions
    WHERE role_permissions.role = get_user_role() AND role_permissions.action = 'close_tab')
    AND is_deleted = false)
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions
    WHERE role_permissions.role = get_user_role() AND role_permissions.action = 'close_tab'));

DROP POLICY IF EXISTS orders_insert_bartender ON public.orders;
CREATE POLICY orders_insert_bartender ON public.orders AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions
    WHERE role_permissions.role = get_user_role() AND role_permissions.action = 'create_order')
    AND staff_id = auth.uid());

DROP POLICY IF EXISTS order_items_insert_bartender ON public.order_items;
CREATE POLICY order_items_insert_bartender ON public.order_items AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions
    WHERE role_permissions.role = get_user_role() AND role_permissions.action = 'create_order'));

DROP POLICY IF EXISTS payments_select_bartender ON public.payments;
CREATE POLICY payments_select_bartender ON public.payments AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM role_permissions
    WHERE role_permissions.role = get_user_role() AND role_permissions.action = 'close_tab')
    AND is_deleted = false);
