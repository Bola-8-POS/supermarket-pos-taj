-- =============================================================================
-- fix(18): parent auto-close trigger must bump tabs.version on its UPDATE
--
-- Root cause: same class of bug as 20260708000001_fix_split_tab_rpcs_version_bump.sql.
-- `check_parent_tab_auto_close()` (20260427000004_parent_auto_close_trigger.sql,
-- Phase 6) fires AFTER INSERT ON payments and, once every sub-tab under a
-- parent is paid, runs `UPDATE tabs SET status = 'paid', ... WHERE id =
-- v_parent_id AND status = 'split'`. That UPDATE does not bump `version`.
-- Phase 15's universal `trg_tabs_version` BEFORE UPDATE trigger on `tabs`
-- (20260512000001_versioned_rows.sql) rejects any update that doesn't advance
-- `version` by exactly +1 — so once the last sub-tab is paid, this trigger's
-- own UPDATE now raises STALE_VERSION (P0V01) from inside the AFTER INSERT
-- trigger on `payments`, which rolls back the entire triggering payment
-- INSERT. The parent tab is left stuck at 'split' forever and the very last
-- sub-tab payment that would have completed the split never gets recorded.
--
-- Fix: add `version = version + 1` to the trigger function's UPDATE tabs
-- statement, following the same pattern established in
-- 20260512000002_rpc_versioned_group_a.sql and
-- 20260708000001_fix_split_tab_rpcs_version_bump.sql.
--
-- Depends on:
--   - 20260427000004_parent_auto_close_trigger.sql (original trigger)
--   - 20260512000001_versioned_rows.sql (version column + bump trigger)
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

  -- If all sub-tabs are paid: auto-close the parent tab.
  -- Phase 15: trg_tabs_version rejects any UPDATE on `tabs` that doesn't
  -- advance version by exactly +1.
  IF v_open_count = 0 THEN
    UPDATE tabs
    SET
      status     = 'paid',
      closed_at  = now(),
      updated_at = now(),
      version    = version + 1
    WHERE id = v_parent_id
      AND status = 'split';  -- only close if still in split state (idempotent guard)
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- Restoring the prior (broken, pre-Phase-15-compliant) trigger function body
-- means re-applying 20260427000004_parent_auto_close_trigger.sql, which will
-- reintroduce the STALE_VERSION bug against trg_tabs_version. Not recommended.
-- COMMIT;
-- =============================================================================
