-- =============================================================================
-- Phase 21-02: profiles.locale + set_own_locale RPC
--
-- Adds a per-staff locale preference (D-01/D-02) that drives i18next's active
-- language on staff-store login/rehydrate (entities/staff/model/store.ts).
--
-- Two write paths (T-21-03, Elevation of Privilege mitigation):
--   - Admin: direct `UPDATE profiles SET locale = ... WHERE id = <staffId>`,
--     gated server-side by the EXISTING `profiles_update_admin` RLS policy
--     (manage_staff action) from 20260510000001_rls_rewrite_phase13.sql.
--     No new policy needed — a non-manage_staff caller is RLS-filtered to
--     0 rows.
--   - Self: `set_own_locale(p_locale, p_terminal_id)` SECURITY DEFINER RPC,
--     scoped to auth.uid()'s own row only (no target-id param — mirrors
--     `clear_must_change_pin` in 20260703000005_force_pin_change.sql), so a
--     bartender (who is blocked from a direct self-UPDATE by
--     profiles_update_admin, since bartenders lack manage_staff) can still
--     set their own locale without ever touching another staff member's row,
--     role, or pin.
--
-- T-21-02 (Tampering, two-layer validation): both the app-level LocaleSchema
-- (domain.ts, z.enum(['es-MX','en-US'])) and this DB CHECK constraint reject
-- out-of-enum locale values.
--
-- Existing rows backfill to 'es-MX' automatically via the column DEFAULT —
-- no separate UPDATE needed (D-02).
-- =============================================================================

-- UP:
BEGIN;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'es-MX';

-- ADD CONSTRAINT is not itself idempotent — guard it explicitly so re-running
-- this migration (or a partial prior apply) is a safe no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_locale_check') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_locale_check CHECK (locale IN ('es-MX', 'en-US'));
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- set_own_locale — self-service only; sets the CALLER's own locale.
-- Deliberately accepts NO target-staff-id parameter (T-21-03): prevents one
-- staff member from setting another's locale, and never touches role/pin.
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_own_locale(
  p_locale      text,
  p_terminal_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  v_uid := auth.uid();

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;

  IF p_locale NOT IN ('es-MX', 'en-US') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: unsupported locale %', p_locale;
  END IF;

  SELECT to_jsonb(p) INTO v_before FROM profiles p WHERE p.id = v_uid;

  UPDATE profiles SET locale = p_locale WHERE id = v_uid;

  SELECT to_jsonb(p) INTO v_after FROM profiles p WHERE p.id = v_uid;

  PERFORM record_audit(
    'staff.locale_change',
    'staff',
    v_uid,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION set_own_locale(text, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION set_own_locale(text, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS set_own_locale(text, text);
-- ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_locale_check;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS locale;
-- -- Safe to drop (unlike must_change_pin in force_pin_change.sql): locale is
-- -- purely additive and new to this phase, with no pre-existing drift or
-- -- unrelated functionality depending on it before this migration.
-- COMMIT;
-- =============================================================================
