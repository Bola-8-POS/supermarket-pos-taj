-- =============================================================================
-- S2-03: no-nesting trigger, require-combo-eligible trigger, is_combo_available function
-- =============================================================================

-- UP: no-nesting trigger, require-combo-eligible trigger, is_combo_available function
BEGIN;

-- Prevent a combo product from being used as a child slot option
CREATE OR REPLACE FUNCTION check_combo_slot_option_not_nested()
RETURNS TRIGGER AS $$
DECLARE
  child_is_combo boolean;
BEGIN
  IF NEW.child_product_id IS NULL THEN
    RETURN NEW;  -- pool_time slots have no child_product_id
  END IF;
  SELECT is_combo INTO child_is_combo FROM products WHERE id = NEW.child_product_id;
  IF child_is_combo THEN
    RAISE EXCEPTION 'NESTED_COMBO_FORBIDDEN: Product % is a combo and cannot be a slot option', NEW.child_product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_combo_slot_option_no_nesting
  BEFORE INSERT OR UPDATE ON combo_slot_options
  FOR EACH ROW EXECUTE FUNCTION check_combo_slot_option_not_nested();

-- Prevent a non-combo-eligible product from being used as a slot option
CREATE OR REPLACE FUNCTION check_combo_slot_option_eligible()
RETURNS TRIGGER AS $$
DECLARE
  child_combo_eligible boolean;
BEGIN
  IF NEW.child_product_id IS NULL THEN
    RETURN NEW;  -- pool_time slots have no child_product_id
  END IF;
  SELECT combo_eligible INTO child_combo_eligible FROM products WHERE id = NEW.child_product_id;
  IF NOT child_combo_eligible THEN
    RAISE EXCEPTION 'INVALID_CHILD: Product % is not combo_eligible', NEW.child_product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_combo_slot_option_eligible
  BEFORE INSERT OR UPDATE ON combo_slot_options
  FOR EACH ROW EXECUTE FUNCTION check_combo_slot_option_eligible();

-- is_combo_available: returns true if the combo is available at the given timestamp
-- Returns true when no availability rows exist (no windows = always available)
CREATE OR REPLACE FUNCTION is_combo_available(p_combo_id uuid, p_ts timestamptz)
RETURNS boolean AS $$
DECLARE
  v_day_of_week integer;
  v_time time;
  v_date date;
  v_row_count integer;
  v_match_count integer;
BEGIN
  SELECT COUNT(*) INTO v_row_count FROM combo_availability WHERE combo_product_id = p_combo_id;
  IF v_row_count = 0 THEN
    RETURN true;  -- no windows = always available
  END IF;

  v_day_of_week := EXTRACT(ISODOW FROM p_ts AT TIME ZONE 'America/Mexico_City')::integer;
  v_time := (p_ts AT TIME ZONE 'America/Mexico_City')::time;
  v_date := (p_ts AT TIME ZONE 'America/Mexico_City')::date;

  SELECT COUNT(*) INTO v_match_count
  FROM combo_availability
  WHERE combo_product_id = p_combo_id
    AND v_day_of_week = ANY(days_of_week)
    AND (start_time IS NULL OR v_time >= start_time)
    AND (end_time IS NULL OR v_time <= end_time)
    AND (start_date IS NULL OR v_date >= start_date)
    AND (end_date IS NULL OR v_date <= end_date);

  RETURN v_match_count > 0;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_combo_slot_option_eligible ON combo_slot_options;
-- DROP FUNCTION IF EXISTS check_combo_slot_option_eligible();
-- DROP TRIGGER IF EXISTS trg_combo_slot_option_no_nesting ON combo_slot_options;
-- DROP FUNCTION IF EXISTS check_combo_slot_option_not_nested();
-- DROP FUNCTION IF EXISTS is_combo_available(uuid, timestamptz);
-- COMMIT;
-- =============================================================================
