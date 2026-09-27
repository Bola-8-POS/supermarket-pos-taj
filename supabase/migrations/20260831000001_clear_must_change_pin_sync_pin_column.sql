-- Fix for a reproduced production bug (2026-08-30/31, the store owner account, see
-- .planning/notes/vinty-owner-login-outage-rca.md "Incident 3"): the forced-PIN-change
-- flow (PINLoginForm.tsx handleConfirmPinComplete) calls two things after the user picks
-- a new PIN:
--   1. supabase.auth.updateUser({ password: newPin })  -- updates auth.users.encrypted_password
--   2. clear_must_change_pin(p_terminal_id)             -- clears profiles.must_change_pin only
--
-- Neither of those ever writes public.profiles.pin. profiles.pin is the plaintext column
-- PINLoginForm's client-side pre-flight check compares against
-- (`enteredPin !== selectedStaff.pin`, PINLoginForm.tsx:76) *before* calling
-- signInWithPassword -- so after a forced PIN change, the two stores permanently
-- diverge: auth.users has the real new password, profiles.pin still has the old value.
-- The next login attempt is rejected at the client-side check with "PIN incorrect",
-- even though the actual credential is correct.
--
-- profiles.pin can't just be updated client-side after the fact either: RLS
-- (profiles_update_admin) requires the manage_staff permission, which a cashier/manager
-- changing their own forced PIN does not necessarily hold. clear_must_change_pin is
-- already SECURITY DEFINER specifically to let a caller touch their own row past that
-- gate (T-14-12, 20260703000005_force_pin_change.sql) -- it just never took a new PIN
-- value to write.
--
-- Fix: clear_must_change_pin now takes the new PIN and writes profiles.pin and
-- profiles.must_change_pin together, atomically, in the same statement -- so the two
-- credential stores can never diverge again the way they just did twice in production.

-- UP:
BEGIN;

DROP FUNCTION IF EXISTS clear_must_change_pin(text);

CREATE OR REPLACE FUNCTION clear_must_change_pin(
  p_new_pin     text,
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

  IF p_new_pin !~ '^\d{6}$' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: PIN must be exactly 6 digits';
  END IF;

  SELECT to_jsonb(p) INTO v_before FROM profiles p WHERE p.id = v_uid;

  UPDATE profiles
  SET pin = p_new_pin,
      must_change_pin = false
  WHERE id = v_uid;

  SELECT to_jsonb(p) INTO v_after FROM profiles p WHERE p.id = v_uid;

  PERFORM record_audit(
    'permission.force_pin_change',
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

GRANT EXECUTE ON FUNCTION clear_must_change_pin(text, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION clear_must_change_pin(text, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS clear_must_change_pin(text, text);
-- -- Original single-arg version is not restored -- it shipped the bug this migration
-- -- fixes. Re-run 20260703000005_force_pin_change.sql's clear_must_change_pin
-- -- definition manually if a rollback is ever genuinely required.
-- COMMIT;
-- =============================================================================
