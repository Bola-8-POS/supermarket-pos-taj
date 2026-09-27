-- Phase 21: Idle Screen Lock (LCK-01..04)
--
-- terminal_lock_settings stores the per-terminal idle-lock timeout (D-02:
-- keyed by TERMINAL_ID, not a store-wide singleton like receipt_settings).
-- Modeled on 20260819000001_receipt_settings.sql, with two deliberate
-- deviations:
--   1. Primary key is `terminal_id TEXT` (the real TERMINAL_ID value), not a
--      generated UUID -- this table is genuinely one row per terminal.
--   2. Write policies check get_user_role() = 'admin', NOT
--      IN ('manager', 'admin') -- manage_settings (D-02/LCK-02) is
--      admin-only in this codebase's RBAC (src/shared/lib/rbac.ts,
--      ADMIN_EXTRA), unlike receipt_settings' manager+admin write policy.

BEGIN;

CREATE TABLE terminal_lock_settings (
  terminal_id TEXT PRIMARY KEY,
  lock_timeout_seconds SMALLINT NOT NULL DEFAULT 60
    CHECK (lock_timeout_seconds BETWEEN 15 AND 600),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES profiles(id)
);

CREATE TRIGGER update_terminal_lock_settings_updated_at BEFORE UPDATE ON terminal_lock_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE terminal_lock_settings ENABLE ROW LEVEL SECURITY;

-- Every authenticated role needs to READ the timeout to arm its own idle timer.
CREATE POLICY "terminal_lock_settings_select_authenticated" ON terminal_lock_settings
  FOR SELECT TO authenticated USING (true);

-- DEVIATION from receipt_settings: manage_settings is ADMIN-ONLY here.
CREATE POLICY "terminal_lock_settings_insert_admin" ON terminal_lock_settings
  FOR INSERT TO authenticated WITH CHECK (get_user_role() = 'admin');
CREATE POLICY "terminal_lock_settings_update_admin" ON terminal_lock_settings
  FOR UPDATE TO authenticated USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');
CREATE POLICY "terminal_lock_settings_delete_admin" ON terminal_lock_settings
  FOR DELETE TO authenticated USING (get_user_role() = 'admin');

NOTIFY pgrst, 'reload schema';

COMMIT;

-- DOWN (not executed automatically -- this repo's migrations have no
-- automated rollback mechanism; kept for documentation per CLAUDE.md's
-- Migration DOWN scripts convention):
-- BEGIN;
-- DROP POLICY IF EXISTS "terminal_lock_settings_delete_admin" ON terminal_lock_settings;
-- DROP POLICY IF EXISTS "terminal_lock_settings_update_admin" ON terminal_lock_settings;
-- DROP POLICY IF EXISTS "terminal_lock_settings_insert_admin" ON terminal_lock_settings;
-- DROP POLICY IF EXISTS "terminal_lock_settings_select_authenticated" ON terminal_lock_settings;
-- ALTER TABLE terminal_lock_settings DISABLE ROW LEVEL SECURITY;
-- DROP TRIGGER IF EXISTS update_terminal_lock_settings_updated_at ON terminal_lock_settings;
-- DROP TABLE IF EXISTS terminal_lock_settings;
-- COMMIT;
