-- =============================================================================
-- Fix transfer_tab: bump tabs.version on its UPDATE
--
-- transfer_tab (20260420000003_transfers.sql, re-signed by
-- 20260703000002_wire_transfer_tab_stock_movement_audit.sql) predates
-- 20260512000001_versioned_rows.sql's trg_tabs_version trigger and was never
-- updated after it landed. Its `UPDATE tabs SET staff_id = ..., table_number
-- = ... WHERE id = p_tab_id` doesn't touch `version`, so bump_version_on_update
-- rejects it with STALE_VERSION (surfaced to callers as a bare Postgrest 500)
-- on every single call — the "Transfer Tab" feature (table and/or staff
-- reassignment) has been completely broken since Phase 15, not something
-- caused by this or the surrounding phases; surfaced by
-- e2e/06-transfer.spec.ts.
--
-- Also adds a `SELECT ... FOR UPDATE` row lock before reading v_tab, matching
-- the close_tab/stop_pool_session precedent, so the version bump is race-safe.
-- =============================================================================

-- UP:
BEGIN;

DROP FUNCTION IF EXISTS transfer_tab(uuid, uuid, uuid, int, text, text, text);

CREATE OR REPLACE FUNCTION transfer_tab(
  p_tab_id          UUID,
  p_transferred_by  UUID,
  p_to_staff_id     UUID DEFAULT NULL,
  p_to_table        INT  DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL,
  p_transfer_type   TEXT DEFAULT 'manual',
  p_terminal_id     TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tab             RECORD;
  v_from_staff_id   UUID;
  v_from_table      INT;
  v_transfer_id     UUID;
  v_before          jsonb;
  v_after           jsonb;
BEGIN
  -- Fetch current tab state (locked, so the version bump below is race-safe)
  SELECT staff_id, table_number, status, version
  INTO v_tab
  FROM tabs
  WHERE id = p_tab_id AND is_deleted = FALSE
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND', 'message', 'Tab not found.'
    ));
  END IF;

  IF v_tab.status <> 'open' THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'TAB_NOT_OPEN', 'message', 'Only open tabs can be transferred.'
    ));
  END IF;

  v_from_staff_id := v_tab.staff_id;
  v_from_table    := v_tab.table_number;

  -- Capture before state (Phase 14-03)
  SELECT to_jsonb(t) INTO v_before FROM tabs t WHERE t.id = p_tab_id;

  -- Apply changes to tab
  UPDATE tabs
  SET
    staff_id     = COALESCE(p_to_staff_id, staff_id),
    table_number = COALESCE(p_to_table, table_number),
    version      = v_tab.version + 1
  WHERE id = p_tab_id;

  -- Log the transfer
  INSERT INTO tab_transfers (
    tab_id, transferred_by, from_staff_id, to_staff_id,
    from_table, to_table, reason, transfer_type
  ) VALUES (
    p_tab_id, p_transferred_by, v_from_staff_id, p_to_staff_id,
    v_from_table, p_to_table, p_reason, p_transfer_type
  )
  RETURNING id INTO v_transfer_id;

  -- AUDIT: record successful tab transfer (Phase 14-03)
  SELECT to_jsonb(t) INTO v_after FROM tabs t WHERE t.id = p_tab_id;
  PERFORM record_audit(
    'tab.transfer',
    'tab',
    p_tab_id,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN json_build_object('ok', true, 'transferId', v_transfer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION transfer_tab(uuid, uuid, uuid, int, text, text, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- Restoring the pre-fix body means reintroducing the version-less UPDATE and
-- dropping the FOR UPDATE lock — see 20260703000002_wire_transfer_tab_stock_movement_audit.sql
-- for that body.
-- COMMIT;
-- =============================================================================
