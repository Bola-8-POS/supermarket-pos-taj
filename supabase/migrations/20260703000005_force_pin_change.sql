-- =============================================================================
-- Phase 14-09: Reconcile profiles.must_change_pin + force_pin_change /
--              clear_must_change_pin RPCs
--
-- `must_change_pin` is read by src/shared/lib/domain.ts (StaffSchema,
-- non-nullable) and src/entities/staff/model/queries.ts (mapStaffRow), yet
-- no migration in this repo ever created the column. Per 14-01 remote-state
-- verification, the column already exists live (drift — created out-of-band,
-- never captured in a migration) while `force_pin_change` does NOT exist
-- live. This migration:
--
--   1. Reconciles the column via an idempotent ADD COLUMN IF NOT EXISTS, so
--      this migration is safe whether or not the column already exists on
--      the target database.
--   2. Creates `force_pin_change(p_staff_id uuid, p_terminal_id text)` — a
--      manager+-gated SECURITY DEFINER RPC that flags a target staff
--      member's must_change_pin=true and audits the action.
--   3. Creates `clear_must_change_pin(p_terminal_id text)` — a self-service
--      SECURITY DEFINER RPC that clears the CALLER's own must_change_pin
--      flag (never a caller-supplied target id) and audits the action.
--
-- Both RPCs use the manager+ auth-check guard shape and pre-RETURN
-- PERFORM record_audit(...) pattern established in
-- 20260511000002_rpc_audit_wiring.sql (process_refund).
--
-- Action label used: 'permission.force_pin_change'
-- (already enumerated in src/shared/lib/audit-actions.ts).
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. Reconcile profiles.must_change_pin (idempotent — column already live
--    per 14-01 verification; safe no-op if it already exists)
-- -----------------------------------------------------------------------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS must_change_pin boolean NOT NULL DEFAULT false;

-- -----------------------------------------------------------------------
-- 2. force_pin_change — manager+ gated, flags a target staff member
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION force_pin_change(
  p_staff_id    uuid,
  p_terminal_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  -- 1. Verify caller is manager or admin
  SELECT id INTO v_caller FROM profiles
  WHERE id = auth.uid()
    AND role IN ('manager', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  -- 2. Capture before state; NOT_FOUND if the target staff does not exist
  SELECT to_jsonb(p) INTO v_before FROM profiles p WHERE p.id = p_staff_id;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: staff % not found', p_staff_id;
  END IF;

  -- 3. Flag the staff member
  UPDATE profiles SET must_change_pin = true WHERE id = p_staff_id;

  -- 4. Capture after state + audit
  SELECT to_jsonb(p) INTO v_after FROM profiles p WHERE p.id = p_staff_id;

  PERFORM record_audit(
    'permission.force_pin_change',
    'staff',
    p_staff_id,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION force_pin_change(uuid, text) TO authenticated;

-- -----------------------------------------------------------------------
-- 3. clear_must_change_pin — self-service only; clears the CALLER's own
--    flag. Deliberately accepts no target-staff-id parameter (T-14-12:
--    prevents one staff member clearing another's forced-change flag).
--    The actual PIN value change (Supabase auth password update) happens
--    client-side in 14-12; this RPC only clears the domain flag.
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clear_must_change_pin(
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

  SELECT to_jsonb(p) INTO v_before FROM profiles p WHERE p.id = v_uid;

  UPDATE profiles SET must_change_pin = false WHERE id = v_uid;

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

GRANT EXECUTE ON FUNCTION clear_must_change_pin(text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION clear_must_change_pin(text) FROM authenticated;
-- DROP FUNCTION IF EXISTS clear_must_change_pin(text);
-- REVOKE EXECUTE ON FUNCTION force_pin_change(uuid, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS force_pin_change(uuid, text);
-- -- must_change_pin column is NOT dropped: it predates this migration (live
-- -- drift per 14-01) and other code (StaffSchema, mapStaffRow) depends on it
-- -- unconditionally; dropping it here would break unrelated functionality
-- -- that existed before this migration was authored.
-- COMMIT;
-- =============================================================================
