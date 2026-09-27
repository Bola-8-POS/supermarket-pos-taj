-- =============================================================================
-- Phase 20 (promotions-engine), Plan 01: is_promotion_available() evaluator
--
-- Cloned near-verbatim from is_combo_available() (20260425000003_combo_triggers.sql)
-- over promotion_availability instead of combo_availability.
-- =============================================================================

-- UP: is_promotion_available function
BEGIN;

-- is_promotion_available: returns true if the promotion is available at the given timestamp
-- Returns true when no availability rows exist (no windows = always available)
CREATE OR REPLACE FUNCTION is_promotion_available(p_promotion_id uuid, p_ts timestamptz)
RETURNS boolean AS $$
DECLARE
  v_day_of_week integer;
  v_time time;
  v_date date;
  v_row_count integer;
  v_match_count integer;
BEGIN
  SELECT COUNT(*) INTO v_row_count FROM promotion_availability WHERE promotion_id = p_promotion_id;
  IF v_row_count = 0 THEN
    RETURN true;  -- no windows = always available
  END IF;

  v_day_of_week := EXTRACT(ISODOW FROM p_ts AT TIME ZONE 'America/Mexico_City')::integer;
  v_time := (p_ts AT TIME ZONE 'America/Mexico_City')::time;
  v_date := (p_ts AT TIME ZONE 'America/Mexico_City')::date;

  SELECT COUNT(*) INTO v_match_count
  FROM promotion_availability
  WHERE promotion_id = p_promotion_id
    AND v_day_of_week = ANY(days_of_week)
    AND (start_time IS NULL OR v_time >= start_time)
    AND (end_time IS NULL OR v_time <= end_time)
    AND (start_date IS NULL OR v_date >= start_date)
    AND (end_date IS NULL OR v_date <= end_date);

  RETURN v_match_count > 0;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION is_promotion_available(uuid, timestamptz) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP FUNCTION IF EXISTS is_promotion_available(uuid, timestamptz);
-- COMMIT;
-- =============================================================================
