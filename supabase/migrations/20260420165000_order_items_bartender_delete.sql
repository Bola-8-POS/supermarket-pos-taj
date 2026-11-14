-- Allow bartenders to DELETE order_items (soft-delete pattern).
-- This enables the remove-item feature: the ManagerPinDialog gates the UI,
-- and after PIN approval the deletion runs under the bartender's auth token.
-- Without this policy, bartenders cannot delete order_items even after
-- manager PIN verification.

CREATE POLICY "order_items_delete_bartender" ON order_items
  FOR DELETE TO authenticated
  USING (get_user_role() = 'bartender');
