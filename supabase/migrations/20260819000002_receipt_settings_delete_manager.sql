-- Fixes SEC-02 / D-04 (Phase 6: Security hardening, Plan 03).
--
-- D-04 (locked, 06-CONTEXT.md) states: "any authenticated staff can SELECT;
-- only manager/admin can INSERT/UPDATE/DELETE" the receipt_settings row.
-- 20260819000001_receipt_settings.sql copied its DELETE policy verbatim from
-- the old dormant SQL in 20260510000001_rls_rewrite_phase13.sql, which
-- restricted DELETE to admin-only — that predates D-04's manager+admin
-- reinterpretation and was never updated to match it. INSERT/UPDATE already
-- correctly allow manager+admin; only DELETE was left admin-only.

BEGIN;

DROP POLICY IF EXISTS "receipt_settings_delete_admin" ON receipt_settings;
CREATE POLICY "receipt_settings_delete_manager_admin" ON receipt_settings FOR DELETE TO authenticated USING (get_user_role() IN ('manager', 'admin'));

NOTIFY pgrst, 'reload schema';

COMMIT;

-- DOWN (not executed automatically — this repo's migrations have no
-- automated rollback mechanism; kept for documentation per CLAUDE.md's
-- Migration DOWN scripts convention):
-- BEGIN;
-- DROP POLICY IF EXISTS "receipt_settings_delete_manager_admin" ON receipt_settings;
-- CREATE POLICY "receipt_settings_delete_admin" ON receipt_settings FOR DELETE TO authenticated USING (get_user_role() = 'admin');
-- COMMIT;
