-- =============================================================================
-- Fix transfer_pool_session: bump pool_sessions.version on its UPDATE
--
-- Same class of bug as 20260713000001_fix_transfer_tab_version_bump.sql:
-- transfer_pool_session (20260420000003_transfers.sql) predates
-- 20260512000001_versioned_rows.sql's trg_pool_sessions_version trigger.
-- Its `UPDATE pool_sessions SET table_id = ... WHERE id = p_session_id`
-- doesn't touch `version`, so bump_version_on_update rejects it with
-- STALE_VERSION on every call — "Move Pool Session" (TransferPoolDialog,
-- table-status page) has been completely broken since Phase 15. Surfaced by
-- e2e/06-transfer.spec.ts "Transfer pool session preserves started_at".
--
-- Also adds a `SELECT ... FOR UPDATE` lock on the pool_sessions row before
-- reading it, matching the transfer_tab / stop_pool_session precedent.
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION transfer_pool_session(
  p_session_id          UUID,
  p_to_pool_table_id    UUID,
  p_transferred_by      UUID,
  p_reason              TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session         RECORD;
  v_target_table    RECORD;
  v_transfer_id     UUID;
BEGIN
  -- Fetch session (locked, so the version bump below is race-safe)
  SELECT id, table_id, tab_id, started_at, stopped_at, is_deleted, version
  INTO v_session
  FROM pool_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.is_deleted THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND', 'message', 'Pool session not found.'
    ));
  END IF;

  IF v_session.stopped_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'SESSION_STOPPED', 'message', 'Cannot transfer a stopped pool session.'
    ));
  END IF;

  -- Fetch target table
  SELECT id, status, is_deleted INTO v_target_table
  FROM pool_tables
  WHERE id = p_to_pool_table_id;

  IF NOT FOUND OR v_target_table.is_deleted THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'TABLE_NOT_FOUND', 'message', 'Target pool table not found.'
    ));
  END IF;

  IF v_target_table.status <> 'available' THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'TABLE_NOT_AVAILABLE',
      'message', 'Target pool table is not available.'
    ));
  END IF;

  -- Free old pool table
  UPDATE pool_tables
  SET status = 'available', current_session_id = NULL
  WHERE id = v_session.table_id;

  -- Update session to point to new table (started_at unchanged — time never resets)
  UPDATE pool_sessions
  SET table_id = p_to_pool_table_id,
      version  = v_session.version + 1
  WHERE id = p_session_id;

  -- Occupy new pool table
  UPDATE pool_tables
  SET status = 'occupied', current_session_id = p_session_id
  WHERE id = p_to_pool_table_id;

  -- Log the transfer
  INSERT INTO pool_table_transfers (
    pool_session_id, transferred_by,
    from_pool_table_id, to_pool_table_id, reason
  ) VALUES (
    p_session_id, p_transferred_by,
    v_session.table_id, p_to_pool_table_id, p_reason
  )
  RETURNING id INTO v_transfer_id;

  RETURN json_build_object('ok', true, 'transferId', v_transfer_id);
END;
$$;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- Restoring the pre-fix body means reintroducing the version-less UPDATE and
-- dropping the FOR UPDATE lock — see 20260420000003_transfers.sql for that body.
-- COMMIT;
-- =============================================================================
