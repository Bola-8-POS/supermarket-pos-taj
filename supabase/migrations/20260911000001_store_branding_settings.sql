-- Phase 33 Plan 01: login screen store branding — settings-concern migration.
--
-- (a) Allows an unauthenticated (anon) client to read the `general` settings row.
-- The login screen renders before any Supabase Auth session exists, so it runs with
-- the `anon` role. Before this policy, `settings` was readable only by
-- authenticated manager/admin sessions (`settings_select_manager_admin`,
-- 20260510000001_rls_rewrite_phase13.sql) — the login screen could never see
-- `storeName`. The predicate `key = 'general'` is the entire security control: it
-- pins anonymous read access to the one branding row and nothing else (billing,
-- receipt, payment_labels, near_expiry, etc. all stay manager/admin-only).
-- STANDING CONSTRAINT: because the `general` blob is now world-readable, no secret
-- or credential may ever be added to it.
--
-- (b) Idempotent data migration: renames the stored JSONB key `barName` ->
-- `storeName` in the existing `general` row so `GeneralSettingsSchema.safeParse`
-- (renamed in the same plan) still matches already-saved data. Guarded by
-- `value ? 'barName'` so re-running this migration is a no-op.
BEGIN;

DROP POLICY IF EXISTS settings_select_branding_anon ON settings;
CREATE POLICY settings_select_branding_anon ON settings
  FOR SELECT TO anon
  USING (key = 'general');

UPDATE settings
SET value = (value - 'barName') || jsonb_build_object('storeName', value->'barName')
WHERE key = 'general' AND value ? 'barName';

COMMIT;
-- No DOWN script (repo convention — all post-pivot migrations are forward-only).
