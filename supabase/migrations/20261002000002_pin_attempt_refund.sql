-- Give back one counted PIN attempt (two-mode plan 01, Task 5A; S11 "refund on 503").
-- staff-sign-in counts an attempt up front (pin_attempt_begin, the burst guard). When the request
-- then fails without evaluating the PIN (profile lookup error, Auth outage or rate limit), the
-- attempt is given back so an outage cannot lock staff out. Same per-key advisory lock as
-- pin_attempt_begin. No BEGIN/COMMIT: the CLI runs each migration file in one transaction.

CREATE OR REPLACE FUNCTION public.pin_attempt_refund(p_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
  v_lock  integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));

  UPDATE public.pin_attempts
  SET failed_count = GREATEST(failed_count - 1, 0)
  WHERE attempt_key = p_key
  RETURNING failed_count INTO v_count;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF v_count = 0 THEN
    DELETE FROM public.pin_attempts WHERE attempt_key = p_key;
    RETURN 0;
  END IF;

  IF v_count >= 5 THEN
    v_lock := LEAST(900, 30 * (2 ^ LEAST(v_count - 5, 5))::integer);
    UPDATE public.pin_attempts
    SET locked_until = now() + make_interval(secs => v_lock)
    WHERE attempt_key = p_key;
  ELSE
    UPDATE public.pin_attempts SET locked_until = NULL WHERE attempt_key = p_key;
  END IF;

  RETURN v_lock;
END;
$$;

REVOKE ALL ON FUNCTION public.pin_attempt_refund(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_attempt_refund(text) TO service_role;

NOTIFY pgrst, 'reload schema';
