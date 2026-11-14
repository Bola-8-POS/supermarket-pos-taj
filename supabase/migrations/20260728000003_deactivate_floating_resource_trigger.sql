-- Auto-deactivate floating resources the instant their pool session stops (D-04).
--
-- D-04 chose an immediate event-driven DB trigger over an idle-timeout/cron
-- scanner. Soft-delete (not hard-delete) is mandatory: pool_sessions.table_id
-- carries ON DELETE RESTRICT, so a hard DELETE on a resources row that any
-- session ever referenced would raise a FK violation and abort the enclosing
-- stop-session transaction. The is_deleted/deleted_at columns already exist
-- (20260420000001_soft_delete.sql) and are currently unused by any resource
-- code path; the SELECT policy's `is_deleted = FALSE` predicate is what makes
-- this soft-delete present to clients as the row simply vanishing.
--
-- Single trigger only, on pool_sessions. There is no companion trigger on
-- tabs: a tab linked to a running pool session cannot reach closed state
-- today (useCloseTab's sessionStillRunningError guard refuses the close), so
-- session-stop is the only real closure path that exists in this codebase
-- (RESEARCH.md Pitfall 1). Consumption-type tables are not an exception —
-- billing reads only rate_per_hour/firstHourMode and is agnostic to
-- table_type, so they go through the identical session start/stop flow.
--
-- The existing hard-delete mutation on the resource entity
-- (useMutationDeleteResource) survives unchanged and is not in conflict: it
-- is guarded to fire only on a row that is available with no current
-- session, i.e. a table that never had a session. A floating table, once
-- used, will always have had a session, so its lifecycle-end goes through
-- this trigger instead. The two deletion mechanisms coexist deliberately.

CREATE OR REPLACE FUNCTION deactivate_floating_resource()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fire only on the transition into stopped. This guard is load-bearing:
  -- without it, any later UPDATE touching an already-stopped session would
  -- re-run the soft-delete (harmless here since it's idempotent, but the
  -- guard is also what keeps this trigger from doing anything on unrelated
  -- pool_sessions UPDATEs).
  IF NEW.stopped_at IS NOT NULL AND OLD.stopped_at IS NULL THEN
    -- is_temp = TRUE is what protects every ordinary table from being
    -- retired by a normal session stop. is_deleted = FALSE makes this
    -- idempotent against a repeated stop on an already-retired resource.
    UPDATE resources
    SET is_deleted = TRUE,
        deleted_at = NOW(),
        status = 'available',
        current_session_id = NULL
    WHERE id = NEW.table_id
      AND is_temp = TRUE
      AND is_deleted = FALSE;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER deactivate_floating_resource_on_session_stop
  AFTER UPDATE ON pool_sessions
  FOR EACH ROW
  EXECUTE FUNCTION deactivate_floating_resource();
