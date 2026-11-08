-- A signed-in cashier may read the settings rows the till prices with
-- (two-mode Plan 02c, Task 7, conditional migration).
--
-- settings was readable by authenticated only for manager/admin
-- (settings_select_manager_admin), and by anon for key 'general'. A cashier
-- session therefore read nothing, and the till priced on built-in defaults
-- (tax 16%, near-expiry 14 days) while the server priced with the stored
-- values. Read-only, three keys, authenticated only; every other key
-- (email_receipts, payment_labels, ...) stays manager/admin. No write change,
-- anon unchanged.

DROP POLICY IF EXISTS settings_select_pricing_keys ON settings;
CREATE POLICY settings_select_pricing_keys ON settings
  FOR SELECT TO authenticated
  USING (key IN ('general', 'billing', 'near_expiry'));

NOTIFY pgrst, 'reload schema';
