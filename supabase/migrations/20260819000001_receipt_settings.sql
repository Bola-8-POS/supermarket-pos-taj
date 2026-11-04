-- Closes SEC-02 / D-04 (Phase 6: Security hardening).
--
-- receipt_settings was referenced in a defensive `IF EXISTS` guard in
-- 20260510000001_rls_rewrite_phase13.sql (lines 975-987) and in CLAUDE.md's
-- table docs, but was never actually CREATE TABLE'd by any migration on this
-- DB — its security posture was unauditable (zero access control, not merely
-- weak access control). Receipt settings currently live as a single row
-- (key = 'receipt') inside the generic `settings` table, whose RLS
-- (settings_select_manager_admin) is admin-only-read — broader restriction
-- than checkout printing actually needs (every role needs to read receipt
-- config; only manager/admin should write it).
--
-- D-04 (locked, CONTEXT.md): receipt_settings is a store-wide singleton, not
-- per-terminal — no terminal/device-identity concept exists anywhere in this
-- schema. D-06 (locked): the new table starts empty, no backfill from the
-- old settings row; DEFAULT_RECEIPT (client-side) covers the empty state.

BEGIN;

CREATE TABLE receipt_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_width_chars SMALLINT NOT NULL DEFAULT 32,
  show_cashier_name BOOLEAN NOT NULL DEFAULT true,
  show_customer_name BOOLEAN NOT NULL DEFAULT true,
  show_receipt_number BOOLEAN NOT NULL DEFAULT true,
  header_line_2 VARCHAR(48) NOT NULL DEFAULT '',
  footer_text VARCHAR(480) NOT NULL DEFAULT '',
  bold_totals BOOLEAN NOT NULL DEFAULT true,
  print_on_start BOOLEAN NOT NULL DEFAULT false,
  auto_cut BOOLEAN NOT NULL DEFAULT false,
  kds_enabled BOOLEAN NOT NULL DEFAULT false,
  logo_data_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES profiles(id)
);

CREATE TRIGGER update_receipt_settings_updated_at BEFORE UPDATE ON receipt_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE receipt_settings ENABLE ROW LEVEL SECURITY;

-- Copied verbatim from the DO $rs$ guard in 20260510000001_rls_rewrite_phase13.sql
-- (lines 981-984), stripped of the IF EXISTS check since the table now
-- genuinely exists at migration time.
CREATE POLICY "receipt_settings_select_authenticated" ON receipt_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "receipt_settings_insert_admin" ON receipt_settings FOR INSERT TO authenticated WITH CHECK (get_user_role() IN ('manager', 'admin'));
CREATE POLICY "receipt_settings_update_admin" ON receipt_settings FOR UPDATE TO authenticated USING (get_user_role() IN ('manager', 'admin')) WITH CHECK (get_user_role() IN ('manager', 'admin'));
CREATE POLICY "receipt_settings_delete_admin" ON receipt_settings FOR DELETE TO authenticated USING (get_user_role() = 'admin');

-- D-06 discretionary cleanup: the old settings row is superseded (never
-- backfilled per D-06) and left-over data would be a stale duplicate that
-- nothing reads anymore.
DELETE FROM settings WHERE key = 'receipt';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- DOWN (not executed automatically — this repo's migrations have no
-- automated rollback mechanism; kept for documentation per CLAUDE.md's
-- Migration DOWN scripts convention):
-- BEGIN;
-- DROP POLICY IF EXISTS "receipt_settings_delete_admin" ON receipt_settings;
-- DROP POLICY IF EXISTS "receipt_settings_update_admin" ON receipt_settings;
-- DROP POLICY IF EXISTS "receipt_settings_insert_admin" ON receipt_settings;
-- DROP POLICY IF EXISTS "receipt_settings_select_authenticated" ON receipt_settings;
-- ALTER TABLE receipt_settings DISABLE ROW LEVEL SECURITY;
-- DROP TRIGGER IF EXISTS update_receipt_settings_updated_at ON receipt_settings;
-- DROP TABLE IF EXISTS receipt_settings;
-- COMMIT;
