-- ============================================================================
-- CAJA SESSIONS
-- One record per business operating day. Distinct from employee shifts.
-- The caja must be open for new tabs to be created.
-- Closing is a hard block if any tab with status='open' exists.
-- ============================================================================

CREATE TABLE IF NOT EXISTS caja_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  opened_by     UUID NOT NULL REFERENCES profiles(id),
  closed_by     UUID REFERENCES profiles(id),
  opening_cash  NUMERIC(12,2) NOT NULL DEFAULT 0,
  closing_cash  NUMERIC(12,2),
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce at most one open caja at a time.
CREATE UNIQUE INDEX IF NOT EXISTS caja_sessions_one_open
  ON caja_sessions (status)
  WHERE status = 'open';

-- Link tabs to the caja session under which they were opened.
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS caja_session_id UUID REFERENCES caja_sessions(id);
CREATE INDEX IF NOT EXISTS tabs_caja_session_id_idx ON tabs (caja_session_id);

-- RLS
ALTER TABLE caja_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read caja sessions"
  ON caja_sessions FOR SELECT TO authenticated USING (true);

-- Only manager/admin can open a caja
CREATE POLICY "Managers can insert caja sessions"
  ON caja_sessions FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('manager', 'admin')
  );

-- Only manager/admin can close a caja
CREATE POLICY "Managers can update caja sessions"
  ON caja_sessions FOR UPDATE TO authenticated
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('manager', 'admin')
  );

-- ============================================================================
-- CLOSE CAJA FUNCTION — enforces hard block on open tabs
-- ============================================================================
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

  -- Perform close
  UPDATE caja_sessions
  SET
    closed_at    = now(),
    closed_by    = p_closed_by,
    closing_cash = p_closing_cash,
    notes        = COALESCE(p_notes, notes),
    status       = 'closed'
  WHERE id = p_caja_id AND status = 'open';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND',
      'message', 'Caja session not found or already closed.'
    ));
  END IF;

  RETURN json_build_object('ok', true);
END;
$$;
