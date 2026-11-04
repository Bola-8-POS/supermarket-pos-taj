-- Generic rate limiting for edge functions.
--
-- One row per key, upserted under an advisory lock. A refused call does not
-- increment hit_count, so a client stuck retrying does not extend its own
-- lockout -- only an allowed call increments. The window resets when it has
-- fully elapsed since window_start.

CREATE TABLE public.rate_limits (
  rate_key     text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  hit_count    integer NOT NULL DEFAULT 0
);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits FROM PUBLIC, anon, authenticated;

-- Returns 0 when the call is allowed (and counted), or the seconds still
-- locked when refused (never 0 on a refusal).
CREATE FUNCTION public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row rate_limits;
BEGIN
  IF p_key IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT';
  END IF;

  -- The row itself is the concurrency guard for a single-row upsert; kept
  -- anyway for parity with pin_attempt_begin's identical pattern
  -- (20260921000003_staff_directory_and_pin_checks.sql:99).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));

  INSERT INTO rate_limits AS r (rate_key, window_start, hit_count)
  VALUES (p_key, now(), 1)
  ON CONFLICT (rate_key) DO UPDATE
    SET window_start = CASE WHEN now() - r.window_start >= make_interval(secs => p_window_seconds) THEN now()
                             ELSE r.window_start END,
        hit_count = CASE WHEN now() - r.window_start >= make_interval(secs => p_window_seconds) THEN 1
                         ELSE r.hit_count + 1 END
  RETURNING r.* INTO v_row;

  IF v_row.hit_count <= p_limit THEN
    RETURN 0;
  END IF;

  -- Refused: undo the increment this call just made (see comment above) and
  -- report the wait against the window that is actually in force.
  UPDATE rate_limits SET hit_count = hit_count - 1 WHERE rate_key = p_key;
  RETURN GREATEST(1, CEIL(EXTRACT(EPOCH FROM v_row.window_start + make_interval(secs => p_window_seconds) - now())))::int;
END;
$$;

-- ponytail: one row per user per rate-limit key never needs a cleanup job at
-- this scale -- no TTL sweep added.

REVOKE ALL ON FUNCTION public.rate_limit_hit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(text, integer, integer) TO service_role;
NOTIFY pgrst, 'reload schema';
