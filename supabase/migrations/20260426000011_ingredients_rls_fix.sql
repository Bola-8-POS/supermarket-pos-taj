-- Fix ingredients RLS: replace auth.jwt()->>'role' with get_user_role()
-- The JWT does not carry a custom 'role' claim; get_user_role() queries profiles.

BEGIN;

DROP POLICY IF EXISTS "manager_admin_write_ingredients" ON ingredients;

CREATE POLICY "manager_admin_write_ingredients" ON ingredients
  FOR ALL TO authenticated
  USING  (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

COMMIT;
