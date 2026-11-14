-- Cloud to local switch fence, hardening (two-mode plan 09). Applies on top of 20261025000001_store_switch_fence.sql; the two
-- files together are "the fence migration" and are deployed in order. Additive, no DOWN script (project convention).
--
-- 1. The statement guard is now a write BARRIER. It takes a row lock (FOR SHARE) on the one store_switch_state row for every
--    guarded write statement, so a freeze (which needs a conflicting lock on that row) WAITS for every write transaction that has
--    already passed the guard, and every later writer sees the frozen row. Cost: one shared row lock per write statement, held to
--    transaction end (about one multixact per transaction under concurrency; measured no worse than the unlocked guard).
--    000001's guard read the state through store_switch_effective_state() and left a gap: a transaction that checked the state
--    while it was draining could commit after the freeze and miss the copy. A REPEATABLE READ / SERIALIZABLE writer whose snapshot
--    predates the freeze fails with 40001 on its first write after it instead.
--    The triggers stay FOR EACH STATEMENT and enabled in the default way (tgenabled 'O'); there is no ENABLE ALWAYS.
-- 2. A missing state row is healed as 'active' by the first guarded write (INSERT ... ON CONFLICT DO NOTHING, default values
--    only, then re-lock and re-read), so the barrier always has a row to lock. The heal can only ever create the default row.
--    A freeze is a plain guarded UPDATE (WHERE op_id = $op AND state = 'draining' AND until_at > clock_timestamp()) whose row count
--    must be exactly 1: a missing row, an uncommitted heal row or a non-draining row all give 0, which the caller treats as a refusal.
--    begin_draining is the only upsert: INSERT ... ON CONFLICT DO NOTHING, then a guarded UPDATE whose row count must also be 1.
-- 3. service_role no longer touches store_switch_state (the switch tool runs as the table owner) and only reads and deletes
--    till_sync_report (it is written through report_till_sync). anon and authenticated keep SELECT on the view only.
-- 4. report_till_sync validates terminal_uuid as a UUID and app_version against a strict character set, and stores the UUID lower-case
--    (upper- and lower-case spellings of one terminal are one row).
--
-- Correction to a comment in 000001: it says the SECURITY DEFINER function is the only reader of the state table. That holds for
-- the roles that can sign in through the API; the switch tool, as the table owner, reads and writes the table directly.

SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.store_fence_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_state text;
  v_until timestamptz;
BEGIN
  SELECT s.state, s.until_at INTO v_state, v_until FROM public.store_switch_state s WHERE s.id FOR SHARE;
  IF NOT FOUND THEN
    INSERT INTO public.store_switch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    SELECT s.state, s.until_at INTO v_state, v_until FROM public.store_switch_state s WHERE s.id FOR SHARE;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;
  -- Same dead-man rule as store_switch_effective_state(): an expired or open-ended freeze is active; moved never expires.
  IF v_state = 'moved' THEN
    RAISE EXCEPTION 'STORE_MOVED: this store moved to its own server; pair this till with it';
  ELSIF v_state = 'frozen' AND v_until > pg_catalog.now() THEN
    RAISE EXCEPTION 'STORE_FROZEN: this store is being moved to its own server; try again in a few minutes';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.store_fence_guard() FROM PUBLIC;

REVOKE ALL ON TABLE public.store_switch_state FROM service_role;
REVOKE ALL ON TABLE public.till_sync_report FROM service_role;
GRANT SELECT, DELETE ON TABLE public.till_sync_report TO service_role;
REVOKE ALL ON public.store_switch_status FROM service_role;
GRANT SELECT ON public.store_switch_status TO service_role;

CREATE OR REPLACE FUNCTION public.report_till_sync(
  p_terminal_uuid     text,
  p_terminal_label    text,
  p_queue_depth       integer,
  p_dead_letter_depth integer,
  p_seen_state        text,
  p_app_version       text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uuid text := lower(p_terminal_uuid);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  IF p_terminal_uuid IS NULL
     OR p_terminal_uuid !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR p_terminal_label IS NULL OR p_terminal_label !~ '^[A-Za-z0-9_-]{1,32}$'
     OR (p_app_version IS NOT NULL AND p_app_version !~ '^[0-9A-Za-z.+_-]{1,32}$')
     OR p_queue_depth IS NULL OR p_queue_depth NOT BETWEEN 0 AND 100000
     OR p_dead_letter_depth IS NULL OR p_dead_letter_depth NOT BETWEEN 0 AND 100000
     OR p_seen_state IS NULL OR p_seen_state NOT IN ('active', 'draining', 'frozen', 'moved') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: invalid till report';
  END IF;
  -- Any signed-in till may call this, so bound the table: a new terminal_uuid is refused once 200 rows exist.
  IF NOT EXISTS (SELECT 1 FROM public.till_sync_report t WHERE t.terminal_uuid = v_uuid)
     AND (SELECT count(*) FROM public.till_sync_report) >= 200 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: too many till reports';
  END IF;
  INSERT INTO public.till_sync_report AS r
    (terminal_uuid, terminal_label, queue_depth, dead_letter_depth, seen_state, app_version, reported_by, reported_at)
  VALUES
    (v_uuid, p_terminal_label, p_queue_depth, p_dead_letter_depth, p_seen_state, p_app_version, auth.uid(), now())
  ON CONFLICT (terminal_uuid) DO UPDATE SET
    reported_by       = EXCLUDED.reported_by,
    terminal_label    = EXCLUDED.terminal_label,
    queue_depth       = EXCLUDED.queue_depth,
    dead_letter_depth = EXCLUDED.dead_letter_depth,
    seen_state        = EXCLUDED.seen_state,
    app_version       = EXCLUDED.app_version,
    reported_at       = EXCLUDED.reported_at;
  RETURN (SELECT e.state FROM public.store_switch_effective_state() e);
END
$$;

NOTIFY pgrst, 'reload schema';
