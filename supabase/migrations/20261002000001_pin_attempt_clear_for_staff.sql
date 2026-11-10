-- Clear a staff member's PIN-attempt counters (two-mode plan 01, Task 5).
-- admin-reset-pin calls this after a successful reset, so a manager who resets a
-- locked-out cashier's PIN does not leave them waiting out the lock (up to 15 min).
-- Keys: login:<id> (account), login:<id>:<address> (per address) and gt:<id> (the
-- Offline-only auth-server hook's key; nothing matches it where that hook is absent).
-- No BEGIN/COMMIT: the CLI already runs each migration file in one transaction.

CREATE OR REPLACE FUNCTION public.pin_attempt_clear_for_staff(p_staff_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH deleted AS (
    DELETE FROM public.pin_attempts
    WHERE attempt_key = 'login:' || p_staff_id::text
       OR attempt_key LIKE 'login:' || p_staff_id::text || ':%'
       OR attempt_key = 'gt:' || p_staff_id::text
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;

REVOKE ALL ON FUNCTION public.pin_attempt_clear_for_staff(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_attempt_clear_for_staff(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
