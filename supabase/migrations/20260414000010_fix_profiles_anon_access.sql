-- =====================================================
-- FIX: Allow anonymous users to read active profiles
-- =====================================================
-- This is needed for the login page to display staff profiles
-- before authentication

CREATE POLICY "profiles_select_anon" ON profiles
  FOR SELECT
  TO anon
  USING (is_active = true);
