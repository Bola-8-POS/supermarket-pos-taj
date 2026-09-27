-- Closes 06-VERIFICATION.md gap / 06-REVIEW.md CR-01 (Phase 6: Security hardening).
--
-- receipt_settings (D-04, 20260819000001) is documented as a store-wide
-- singleton but had no DB-level enforcement: `id` defaulted to
-- gen_random_uuid() and the INSERT policy's WITH CHECK tested role only,
-- never `id`. The phase's own integration test proved a manager/admin
-- INSERT with no explicit id succeeds, creating a second row — every read
-- (useReceiptSettings()) uses .maybeSingle(), which throws the moment a
-- second row exists, breaking receipt printing/logo/Hardware Settings
-- store-wide.
--
-- Fix: pin the column default to the sentinel id the client always upserts
-- (RECEIPT_SETTINGS_SINGLETON_ID in queries.ts) and require INSERT to target
-- that exact id. Any pre-existing non-sentinel row is collapsed first so the
-- new constraint doesn't fail on deploy.

BEGIN;

DELETE FROM receipt_settings WHERE id <> '00000000-0000-0000-0000-000000000001';

ALTER TABLE receipt_settings ALTER COLUMN id SET DEFAULT '00000000-0000-0000-0000-000000000001';

DROP POLICY IF EXISTS "receipt_settings_insert_admin" ON receipt_settings;
CREATE POLICY "receipt_settings_insert_admin" ON receipt_settings FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin') AND id = '00000000-0000-0000-0000-000000000001');

NOTIFY pgrst, 'reload schema';

COMMIT;

-- DOWN (not executed automatically — this repo's migrations have no
-- automated rollback mechanism; kept for documentation per CLAUDE.md's
-- Migration DOWN scripts convention):
-- BEGIN;
-- DROP POLICY IF EXISTS "receipt_settings_insert_admin" ON receipt_settings;
-- CREATE POLICY "receipt_settings_insert_admin" ON receipt_settings FOR INSERT TO authenticated WITH CHECK (get_user_role() IN ('manager', 'admin'));
-- ALTER TABLE receipt_settings ALTER COLUMN id SET DEFAULT gen_random_uuid();
-- COMMIT;
