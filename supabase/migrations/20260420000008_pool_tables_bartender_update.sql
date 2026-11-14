-- Allow bartenders to update pool_tables status when managing pool sessions.
-- The existing policy restricts updates to manager/admin only, but bartenders
-- need to update status and current_session_id when starting/stopping sessions.
CREATE POLICY "pool_tables_update_bartender" ON pool_tables
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'bartender')
  WITH CHECK (get_user_role() = 'bartender');
