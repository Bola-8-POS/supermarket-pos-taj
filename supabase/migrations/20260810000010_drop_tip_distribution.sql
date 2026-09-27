-- =============================================================================
-- Phase 01 (strip-rebrand), Plan 12 Task 2: [BLOCKING] drop tip_distribution_entries
-- and restore close_caja_session without the tip-bucket-distribution block (D-21).
--
-- D-21: bar-specific floor/bar/kitchen tip-splitting doesn't apply to grocery
-- cashiers. Removes the "Tip Split" Settings tab / Reports tab feature and its
-- schema entirely — code already deleted in Plan 12 Task 1.
--
-- Highest-risk part of this plan (Pitfall 4): close_caja_session is a shared,
-- generic, KEPT function every caja close depends on. 20260709000002 bundled
-- two unrelated changes into one CREATE OR REPLACE:
--   1. FIX (unrelated bug, KEEP): `version = version + 1` in the
--      `UPDATE caja_sessions` statement — without it, Phase 15's
--      trg_caja_sessions_version trigger rejects every close with
--      STALE_VERSION.
--   2. FEATURE (REMOVE): tip pooling + largest-remainder split + INSERT INTO
--      tip_distribution_entries + the 'tip_distribution.compute' audit call.
--
-- Live-introspection finding (this task's required pre-migration check, per
-- prior wave-3 plans' established pattern): the LIVE close_caja_session body
-- differs from the 20260709000002 migration FILE — Phase 23's
-- 20260720000005_fix_payment_sums_exclude_reopened_void.sql patched the tip
-- pooling SELECT in place to add `AND status IS DISTINCT FROM 'reopened_void'`
-- (voided-via-reopen-tab payments must not count toward the tip pool). That
-- entire SELECT lives inside the tip-distribution block being removed here,
-- so the Phase 23 patch is removed along with it — verified via live
-- `pg_proc.prosrc` grep (only consumer of `tip_distribution_entries` in
-- public schema functions is close_caja_session itself; no triggers, views,
-- or other functions reference the table).
--
-- The rewrite below is the LIVE function body (not the older migration file)
-- minus the "Phase 19: tip-bucket distribution" block, so the version-bump
-- fix and every other Phase 14/15/23 change already folded into this RPC are
-- preserved untouched. Signature, SECURITY DEFINER, permission check,
-- open-tabs guard, and the 'caja.close' audit call are unchanged.
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION close_caja_session(
  p_caja_id      UUID,
  p_closed_by    UUID,
  p_closing_cash NUMERIC(12,2),
  p_notes        TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_tab_count INT;
  v_caller_role TEXT;
  v_before_row jsonb;
  v_after_row  jsonb;
BEGIN
  -- Permission check
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('manager', 'admin') THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'PERMISSION_DENIED',
      'message', 'Only managers and admins can close the caja.'
    ));
  END IF;

  -- Hard block: no open tabs allowed
  SELECT COUNT(*) INTO v_open_tab_count
  FROM tabs
  WHERE caja_session_id = p_caja_id
    AND status = 'open'
    AND is_deleted = FALSE;

  IF v_open_tab_count > 0 THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'OPEN_TABS_EXIST',
      'message', format(
        'Cannot close the caja: %s tab(s) are still open. Close all tabs before closing the caja.',
        v_open_tab_count
      ),
      'openTabCount', v_open_tab_count
    ));
  END IF;

  -- Capture before state
  SELECT to_jsonb(c) INTO v_before_row FROM caja_sessions c WHERE c.id = p_caja_id;

  -- Perform close
  UPDATE caja_sessions
  SET
    closed_at    = now(),
    closed_by    = p_closed_by,
    closing_cash = p_closing_cash,
    notes        = COALESCE(p_notes, notes),
    status       = 'closed',
    version      = version + 1
  WHERE id = p_caja_id AND status = 'open';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND',
      'message', 'Caja session not found or already closed.'
    ));
  END IF;

  -- AUDIT: record successful caja close (Phase 14-03)
  SELECT to_jsonb(c) INTO v_after_row FROM caja_sessions c WHERE c.id = p_caja_id;
  PERFORM record_audit(
    'caja.close',
    'caja_session',
    p_caja_id,
    v_before_row,
    v_after_row,
    'rpc'
  );

  RETURN json_build_object('ok', true);
END;
$$;

DROP TABLE IF EXISTS tip_distribution_entries CASCADE;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- DOWN (D-19): rollback not recommended.
-- Restoring tip_distribution_entries would require re-applying
-- 20260709000001_tip_distribution_entries_table.sql (table) and
-- 20260709000002_close_caja_session_tip_distribution.sql (function), which
-- reverts the Phase 23 reopened_void tip-pooling fix along with it since that
-- fix lived entirely inside the block being removed here. Historical tip
-- split data for cajas closed after this migration cannot be recovered
-- (no writer exists once close_caja_session no longer computes it).
-- =============================================================================
