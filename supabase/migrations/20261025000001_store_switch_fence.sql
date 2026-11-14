-- Cloud to local switch fence (two-mode plan 09; docs/superpowers/plans/2026-10-02-two-mode-09-cloud-to-local-switch.md).
--
-- A store that moves from its cloud project to its own server must (1) stop the tills from starting new work,
-- (2) let them flush their offline queues, (3) refuse every write so a consistent copy can be taken,
-- (4) say "moved" afterwards so an unpaired till shows "pair this till" instead of selling into a frozen cloud.
--
-- States (public.store_switch_state, one row):
--   active    normal.
--   draining  tills stop NEW work and flush; writes are still accepted.
--   frozen    every write to a business table is refused (STORE_FROZEN:).
--   moved     permanent; every write is refused (STORE_MOVED:).
-- draining and frozen carry until_at: past it the effective state is active again (dead-man), so a switch that
-- crashes can never leave the store frozen. moved has no expiry. A missing row means active.
--
-- Enforcement is one statement-level trigger per public base table (a statement trigger fires even when no row
-- matches, and costs one read of a one-row table per statement). The tables that must stay writable while the
-- store is fenced are exempt: store_switch_state (the switch tool), till_sync_report (tills acknowledge the fence),
-- pin_attempts (sign-in lock bookkeeping). A table created by a LATER migration has no trigger until that
-- migration adds one; `posctl switch plan` refuses to run while any table is unguarded.
--
-- Additive, no DOWN script (project convention). To remove: DROP TRIGGER store_fence_guard ON every public table,
-- DROP FUNCTION public.store_fence_guard(), public.report_till_sync(...), public.store_switch_effective_state(),
-- DROP VIEW public.store_switch_status, DROP TABLE public.till_sync_report, public.store_switch_state.

SET LOCAL lock_timeout = '15s';

CREATE TABLE public.store_switch_state (
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  state       text        NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'draining', 'frozen', 'moved')),
  op_id       text,
  since       timestamptz NOT NULL DEFAULT now(),
  drain_since timestamptz,
  until_at    timestamptz
);
INSERT INTO public.store_switch_state (id) VALUES (true);
ALTER TABLE public.store_switch_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.store_switch_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.store_switch_state TO service_role;

-- Returns (state, since): the SECURITY DEFINER function is the only reader of the locked-down state table, so the public
-- view below can be security_invoker and expose nothing but these two columns.
CREATE FUNCTION public.store_switch_effective_state()
RETURNS TABLE (state text, since timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT CASE
             WHEN s.state IN ('draining', 'frozen') AND (s.until_at IS NULL OR s.until_at <= now()) THEN 'active'
             ELSE s.state
           END
    FROM public.store_switch_state s
    WHERE s.id
  ), 'active'),
  (SELECT s.since FROM public.store_switch_state s WHERE s.id)
$$;
REVOKE ALL ON FUNCTION public.store_switch_effective_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_switch_effective_state() TO anon, authenticated, service_role;

-- What the app polls (GET /rest/v1/store_switch_status?select=state). No operation id, no timestamps beyond `since`.
CREATE VIEW public.store_switch_status WITH (security_invoker = true) AS
  SELECT e.state, e.since FROM public.store_switch_effective_state() e;
REVOKE ALL ON public.store_switch_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.store_switch_status TO anon, authenticated, service_role;

CREATE FUNCTION public.store_fence_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state text := (SELECT state FROM public.store_switch_effective_state());
BEGIN
  IF v_state = 'frozen' THEN
    RAISE EXCEPTION 'STORE_FROZEN: this store is being moved to its own server; try again in a few minutes';
  ELSIF v_state = 'moved' THEN
    RAISE EXCEPTION 'STORE_MOVED: this store moved to its own server; pair this till with it';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.store_fence_guard() FROM PUBLIC;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname NOT IN ('store_switch_state', 'till_sync_report', 'pin_attempts')
  LOOP
    EXECUTE format(
      'CREATE TRIGGER store_fence_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.store_fence_guard()',
      r.relname);
  END LOOP;
END
$$;

-- What each till last said about its unsynced offline work. Read by `posctl switch` over a direct connection only.
CREATE TABLE public.till_sync_report (
  terminal_uuid     text        PRIMARY KEY,
  terminal_label    text        NOT NULL,
  queue_depth       integer     NOT NULL CHECK (queue_depth >= 0),
  dead_letter_depth integer     NOT NULL DEFAULT 0 CHECK (dead_letter_depth >= 0),
  seen_state        text        NOT NULL CHECK (seen_state IN ('active', 'draining', 'frozen', 'moved')),
  app_version       text,
  reported_by       uuid        NOT NULL DEFAULT auth.uid(),
  reported_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.till_sync_report ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.till_sync_report FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.till_sync_report TO service_role;

-- A signed-in till reports its queue; the answer is the effective state, so one call both reports and learns.
CREATE FUNCTION public.report_till_sync(
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
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  IF p_terminal_uuid IS NULL OR length(p_terminal_uuid) NOT BETWEEN 8 AND 64
     OR p_terminal_label IS NULL OR p_terminal_label !~ '^[A-Za-z0-9_-]{1,32}$'
     OR p_queue_depth IS NULL OR p_queue_depth NOT BETWEEN 0 AND 100000
     OR p_dead_letter_depth IS NULL OR p_dead_letter_depth NOT BETWEEN 0 AND 100000
     OR p_seen_state IS NULL OR p_seen_state NOT IN ('active', 'draining', 'frozen', 'moved') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: invalid till report';
  END IF;
  -- Any signed-in till may call this, so bound the table: a new terminal_uuid is refused once 200 rows exist.
  IF NOT EXISTS (SELECT 1 FROM public.till_sync_report t WHERE t.terminal_uuid = p_terminal_uuid)
     AND (SELECT count(*) FROM public.till_sync_report) >= 200 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: too many till reports';
  END IF;
  INSERT INTO public.till_sync_report AS r
    (terminal_uuid, terminal_label, queue_depth, dead_letter_depth, seen_state, app_version, reported_by, reported_at)
  VALUES
    (p_terminal_uuid, p_terminal_label, p_queue_depth, p_dead_letter_depth, p_seen_state, left(p_app_version, 32), auth.uid(), now())
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
REVOKE ALL ON FUNCTION public.report_till_sync(text, text, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_till_sync(text, text, integer, integer, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
