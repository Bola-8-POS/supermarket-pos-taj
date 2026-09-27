-- ============================================================================
-- TAB TRANSFERS
-- Audit trail for tab reassignments (staff change, table number change,
-- or moving from a dining table to a pool table and vice versa).
-- ============================================================================

CREATE TABLE IF NOT EXISTS tab_transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id          UUID NOT NULL REFERENCES tabs(id),
  transferred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  transferred_by  UUID NOT NULL REFERENCES profiles(id),
  from_staff_id   UUID REFERENCES profiles(id),
  to_staff_id     UUID REFERENCES profiles(id),
  from_table      INT,
  to_table        INT,
  reason          TEXT,
  transfer_type   TEXT NOT NULL DEFAULT 'manual'
    CHECK (transfer_type IN ('staff', 'table', 'pool_to_dining', 'dining_to_pool', 'pool_to_pool', 'manual'))
);

CREATE INDEX IF NOT EXISTS tab_transfers_tab_id_idx ON tab_transfers (tab_id);
CREATE INDEX IF NOT EXISTS tab_transfers_transferred_at_idx ON tab_transfers (transferred_at);

ALTER TABLE tab_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read tab transfers"
  ON tab_transfers FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can insert tab transfers"
  ON tab_transfers FOR INSERT TO authenticated WITH CHECK (true);

-- ============================================================================
-- POOL TABLE TRANSFERS
-- Audit trail when a pool session moves from one pool table to another.
-- The session's started_at is preserved — time does NOT reset.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pool_table_transfers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_session_id     UUID NOT NULL REFERENCES pool_sessions(id),
  transferred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  transferred_by      UUID NOT NULL REFERENCES profiles(id),
  from_pool_table_id  UUID NOT NULL REFERENCES pool_tables(id),
  to_pool_table_id    UUID NOT NULL REFERENCES pool_tables(id),
  reason              TEXT
);

CREATE INDEX IF NOT EXISTS pool_table_transfers_session_idx ON pool_table_transfers (pool_session_id);

ALTER TABLE pool_table_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read pool table transfers"
  ON pool_table_transfers FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can insert pool table transfers"
  ON pool_table_transfers FOR INSERT TO authenticated WITH CHECK (true);

-- ============================================================================
-- TRANSFER TAB RPC
-- Atomically reassigns a tab's staff_id and/or table_number,
-- logs the transfer, and handles pool session relinking.
-- ============================================================================

CREATE OR REPLACE FUNCTION transfer_tab(
  p_tab_id          UUID,
  p_transferred_by  UUID,
  p_to_staff_id     UUID DEFAULT NULL,
  p_to_table        INT  DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL,
  p_transfer_type   TEXT DEFAULT 'manual'
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
BEGIN
  -- Fetch current tab state
  SELECT staff_id, table_number, status
  INTO v_tab
  FROM tabs
  WHERE id = p_tab_id AND is_deleted = FALSE;

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

  -- Apply changes to tab
  UPDATE tabs
  SET
    staff_id     = COALESCE(p_to_staff_id, staff_id),
    table_number = COALESCE(p_to_table, table_number)
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

  RETURN json_build_object('ok', true, 'transferId', v_transfer_id);
END;
$$;

-- ============================================================================
-- TRANSFER POOL SESSION RPC
-- Moves an active pool session from one pool table to another.
-- started_at is preserved. Old table freed, new table occupied.
-- ============================================================================

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
  -- Fetch session
  SELECT id, table_id, tab_id, started_at, stopped_at, is_deleted
  INTO v_session
  FROM pool_sessions
  WHERE id = p_session_id;

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
  SET table_id = p_to_pool_table_id
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
