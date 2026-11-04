-- =============================================================================
-- Phase 19: close_caja_session — tip-bucket distribution + version-bump fix
--
-- Two changes bundled into this single CREATE OR REPLACE (both require the
-- exact same function to be re-declared, so they land together):
--
--   1. FIX (pre-existing bug, not caused by this phase — 19-RESEARCH.md
--      Pitfall 1): the existing `UPDATE caja_sessions SET ... WHERE id =
--      p_caja_id AND status = 'open'` never included `version = version + 1`.
--      Phase 15's `trg_caja_sessions_version` trigger
--      (`bump_version_on_update()`, 20260512000001_versioned_rows.sql)
--      rejects ANY update to caja_sessions whose `NEW.version` does not equal
--      `OLD.version + 1` — including updates that never touch `version` at
--      all. Every close_caja_session call today raises STALE_VERSION
--      (SQLSTATE P0V01) and the whole close rolls back. This is a two-line
--      fix riding along with the already-required migration below (the same
--      pattern already applied to split_tab_by_item/person/amount in
--      20260708000001_fix_split_tab_rpcs_version_bump.sql).
--
--   2. FEATURE (D-02/D-03/D-04, SC-2): after the close succeeds and the
--      existing 'caja.close' audit record is written, pool
--      SUM(payments.tip_amount) across ALL payment methods (A2 — no rappi
--      exclusion, Pitfall 3) for the session's non-deleted tabs, read the
--      settings key='tip_distribution' config (falling back to the
--      documented 34/33/33 default if absent — Pitfall 4), split the pooled
--      total via largest-remainder with a floor > bar > kitchen tiebreak,
--      and INSERT exactly one row into tip_distribution_entries in the SAME
--      transaction as the close. A missing config or zero tips (Pitfall 5)
--      must NOT crash the close.
--
-- The RPC's public contract is unchanged: same signature, same
-- `RETURN json_build_object('ok', true)` success shape (the client hook only
-- reads `.ok`).
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
  -- Tip distribution locals (Phase 19)
  v_tab_ids        uuid[];
  v_total_tips     numeric(10,2);
  v_config         jsonb;
  v_floor_pct      numeric(5,2);
  v_bar_pct        numeric(5,2);
  v_kitchen_pct    numeric(5,2);
  v_floor_amount   numeric(10,2);
  v_bar_amount     numeric(10,2);
  v_kitchen_amount numeric(10,2);
  v_remainder      numeric(10,2);
  v_entry_id       uuid;
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

  -- ---------------------------------------------------------------------
  -- Phase 19: tip-bucket distribution (D-02, D-03) — same transaction
  -- ---------------------------------------------------------------------

  -- Collect this session's non-deleted tab ids (mirror get_caja_report)
  SELECT array_agg(id) INTO v_tab_ids
  FROM tabs
  WHERE caja_session_id = p_caja_id AND is_deleted = FALSE;

  IF v_tab_ids IS NULL THEN
    v_tab_ids := '{}';
  END IF;

  -- Pool tips across ALL payment methods (A2 — no rappi exclusion, Pitfall 3)
  SELECT COALESCE(SUM(tip_amount), 0) INTO v_total_tips
  FROM payments
  WHERE tab_id = ANY(v_tab_ids) AND is_deleted = FALSE;

  -- Read the distribution config, falling back to 34/33/33 if absent (Pitfall 4)
  SELECT value INTO v_config FROM settings WHERE key = 'tip_distribution';
  IF NOT FOUND OR v_config IS NULL THEN
    v_config := '{"floorPct":34,"barPct":33,"kitchenPct":33}'::jsonb;
  END IF;

  v_floor_pct   := COALESCE((v_config->>'floorPct')::numeric, 34);
  v_bar_pct     := COALESCE((v_config->>'barPct')::numeric, 33);
  v_kitchen_pct := COALESCE((v_config->>'kitchenPct')::numeric, 33);

  -- Largest-remainder split (D-02). No sum-to-100 rejection (D-01) — zero
  -- tips naturally yield 0/0/0 with v_remainder = 0 (Pitfall 5).
  v_floor_amount   := trunc(v_total_tips * v_floor_pct / 100, 2);
  v_bar_amount     := trunc(v_total_tips * v_bar_pct / 100, 2);
  v_kitchen_amount := trunc(v_total_tips * v_kitchen_pct / 100, 2);
  v_remainder      := v_total_tips - (v_floor_amount + v_bar_amount + v_kitchen_amount);

  IF v_remainder > 0 THEN
    -- Tiebreak: assign the FULL remainder to the largest pct, floor > bar > kitchen
    IF v_floor_pct >= v_bar_pct AND v_floor_pct >= v_kitchen_pct THEN
      v_floor_amount := v_floor_amount + v_remainder;
    ELSIF v_bar_pct >= v_kitchen_pct THEN
      v_bar_amount := v_bar_amount + v_remainder;
    ELSE
      v_kitchen_amount := v_kitchen_amount + v_remainder;
    END IF;
  END IF;

  -- Sole writer of tip_distribution_entries (D-04). ON CONFLICT DO NOTHING is
  -- defense-in-depth against a re-close race — the WHERE status='open' guard
  -- above already prevents normal re-close.
  INSERT INTO tip_distribution_entries (
    caja_session_id, floor_pct, bar_pct, kitchen_pct,
    total_tips, floor_amount, bar_amount, kitchen_amount
  ) VALUES (
    p_caja_id, v_floor_pct, v_bar_pct, v_kitchen_pct,
    v_total_tips, v_floor_amount, v_bar_amount, v_kitchen_amount
  )
  ON CONFLICT (caja_session_id) DO NOTHING
  RETURNING id INTO v_entry_id;

  PERFORM record_audit('tip_distribution.compute',
    'tip_distribution_entry',
    p_caja_id,
    NULL,
    jsonb_build_object(
      'totalTips', v_total_tips,
      'floorAmount', v_floor_amount,
      'barAmount', v_bar_amount,
      'kitchenAmount', v_kitchen_amount,
      'floorPct', v_floor_pct,
      'barPct', v_bar_pct,
      'kitchenPct', v_kitchen_pct
    ),
    'rpc'
  );

  RETURN json_build_object('ok', true);
END;
$$;

COMMIT;

-- =============================================================================
-- DOWN:
-- Rollback means re-applying the prior close_caja_session body from
-- 20260511000002_rpc_audit_wiring.sql, which reintroduces the
-- STALE_VERSION bug (Pitfall 1) — rollback is NOT recommended.
-- =============================================================================
