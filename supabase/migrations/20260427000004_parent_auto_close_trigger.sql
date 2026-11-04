-- =============================================================================
-- S4-14: Parent auto-close trigger
--
-- Fires AFTER INSERT on payments. When all sub-tabs under a parent tab are paid,
-- automatically marks the parent tab as paid and sets closed_at.
--
-- Security control (T-06-09):
--   - First guard: IF NEW.is_refund THEN RETURN NEW — refund payment rows never
--     trigger parent-close logic, preventing incorrect auto-close.
--
-- Depends on: 20260427000001_split_bill_schema.sql
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION check_parent_tab_auto_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent_id  uuid;
  v_open_count integer;
BEGIN
  -- Guard: refund payment rows must never trigger auto-close (T-06-09)
  IF NEW.is_refund THEN
    RETURN NEW;
  END IF;

  -- Get parent_tab_id of the tab that was just paid
  SELECT parent_tab_id INTO v_parent_id
  FROM tabs
  WHERE id = NEW.tab_id;

  -- If not a sub-tab (no parent), nothing to do
  IF v_parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count sub-tabs under the parent that are not yet paid
  SELECT COUNT(*) INTO v_open_count
  FROM tabs
  WHERE parent_tab_id = v_parent_id
    AND status != 'paid';

  -- If all sub-tabs are paid: auto-close the parent tab
  IF v_open_count = 0 THEN
    UPDATE tabs
    SET
      status     = 'paid',
      closed_at  = now(),
      updated_at = now()
    WHERE id = v_parent_id
      AND status = 'split';  -- only close if still in split state (idempotent guard)
  END IF;

  RETURN NEW;
END;
$$;

-- Drop existing trigger if present (safe re-run via CREATE OR REPLACE above)
DROP TRIGGER IF EXISTS after_payment_insert_check_parent_close ON payments;

CREATE TRIGGER after_payment_insert_check_parent_close
  AFTER INSERT ON payments
  FOR EACH ROW
  EXECUTE FUNCTION check_parent_tab_auto_close();

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TRIGGER IF EXISTS after_payment_insert_check_parent_close ON payments;
-- DROP FUNCTION IF EXISTS check_parent_tab_auto_close();
-- COMMIT;
-- =============================================================================
