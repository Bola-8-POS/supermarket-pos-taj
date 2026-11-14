-- Staff directory and server-side PIN checks.
--
-- 1. staff_directory: the staff list used by the sign-in screen and the
--    in-app staff pickers (id, name, role and display flags).
-- 2. pin_attempts with three helpers: shared attempt limiting for PIN checks.
--    Locks are time-based and expire on their own.
-- 3. verify_staff_pin: PIN check for signed-in callers.
-- 4. staff_pin_holder: staff-management helper for the reset dialog.
-- 5. role_permissions seed: the transfer confirmation and dispute prompts'
--    actions, missing since Phase 23, needed now that verify_staff_pin's
--    p_required_action rule enforces role_permissions as the sole source
--    of truth for eligibility.
--
-- Additive: no existing object changes.

CREATE VIEW public.staff_directory AS
  SELECT p.id, p.name, p.role, p.is_active, p.must_change_pin, p.locale
  FROM public.profiles p
  WHERE p.is_active = true;

-- Read-only for the client roles (a simple view is otherwise writable).
REVOKE ALL ON public.staff_directory FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.staff_directory TO anon, authenticated, service_role;

CREATE TABLE public.pin_attempts (
  attempt_key  text PRIMARY KEY,
  failed_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pin_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pin_attempts FROM PUBLIC, anon, authenticated;

-- Seconds until p_key may try again (0 = allowed now).
CREATE FUNCTION public.pin_attempt_retry_after(p_key text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT CEIL(EXTRACT(EPOCH FROM (a.locked_until - now())))::integer
    FROM pin_attempts a
    WHERE a.attempt_key = p_key AND a.locked_until > now()
  ), 0)
$$;

-- Records one outcome for p_key and returns the lock now in force, in seconds.
-- Four attempts are free; the fifth and later attempts lock the key for 30 s,
-- doubling with each further attempt, capped at 15 minutes. A success clears
-- the key. A key with no attempt for 30 minutes starts again at one.
CREATE FUNCTION public.pin_attempt_record(p_key text, p_success boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
  v_lock  integer := 0;
BEGIN
  IF p_success THEN
    DELETE FROM pin_attempts WHERE attempt_key = p_key;
    RETURN 0;
  END IF;

  INSERT INTO pin_attempts AS a (attempt_key, failed_count, updated_at)
  VALUES (p_key, 1, now())
  ON CONFLICT (attempt_key) DO UPDATE
    SET failed_count = CASE WHEN a.updated_at < now() - interval '30 minutes' THEN 1
                            ELSE a.failed_count + 1 END,
        updated_at = now()
  RETURNING a.failed_count INTO v_count;

  IF v_count >= 5 THEN
    v_lock := LEAST(900, 30 * (2 ^ LEAST(v_count - 5, 5))::integer);
    UPDATE pin_attempts
    SET locked_until = now() + make_interval(secs => v_lock)
    WHERE attempt_key = p_key;
  END IF;

  RETURN v_lock;
END;
$$;

-- Opens one attempt for p_key. Serialized per key. Returns the seconds still
-- locked (the attempt is refused and not counted), or 0 after counting the
-- attempt up front; a success clears the key through pin_attempt_record.
CREATE FUNCTION public.pin_attempt_begin(p_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wait integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));
  v_wait := pin_attempt_retry_after(p_key);
  IF v_wait > 0 THEN
    RETURN v_wait;
  END IF;
  PERFORM pin_attempt_record(p_key, false);
  RETURN 0;
END;
$$;

REVOKE ALL ON FUNCTION public.pin_attempt_retry_after(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pin_attempt_record(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pin_attempt_begin(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pin_attempt_retry_after(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pin_attempt_record(text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.pin_attempt_begin(text) TO service_role;

-- PIN check for a signed-in caller. With p_staff_id the PIN must belong to
-- that staff member; without it, every active staff member holding the PIN
-- is returned (name order) and the caller applies its own role rule.
-- A wrong PIN is returned, not raised, so the counted attempt is kept.
-- With p_required_action, only staff whose role holds that action count as
-- a match; the attempt is cleared only on a match the caller may use.
CREATE FUNCTION public.verify_staff_pin(p_pin text, p_staff_id uuid DEFAULT NULL, p_required_action text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_key     text;
  v_wait    integer;
  v_matches jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  v_key := 'caller:' || v_uid::text;

  v_wait := pin_attempt_begin(v_key);
  IF v_wait > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LOCKED', 'retry_after', v_wait);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role) ORDER BY p.name)
    INTO v_matches
  FROM profiles p
  WHERE p.is_active = true
    AND p_pin ~ '^\d{6}$'
    AND p.pin = p_pin
    AND (p_staff_id IS NULL OR p.id = p_staff_id)
    AND (p_required_action IS NULL OR EXISTS (
      SELECT 1 FROM role_permissions rp WHERE rp.role = p.role AND rp.action = p_required_action
    ));

  IF v_matches IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_PIN', 'retry_after', pin_attempt_retry_after(v_key));
  END IF;

  PERFORM pin_attempt_record(v_key, true);
  RETURN jsonb_build_object('ok', true, 'matches', v_matches);
END;
$$;

REVOKE ALL ON FUNCTION public.verify_staff_pin(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_staff_pin(text, uuid, text) TO authenticated, service_role;

-- Name of an active staff member who already uses p_pin (NULL when free).
-- Staff managers only; used for the duplicate warning when a PIN is reset.
CREATE FUNCTION public.staff_pin_holder(p_pin text, p_exclude_staff_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role = get_user_role() AND rp.action = 'manage_staff'
  ) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: staff management permission required';
  END IF;

  SELECT p.name INTO v_name
  FROM profiles p
  WHERE p.is_active = true
    AND p.pin = p_pin
    AND (p_exclude_staff_id IS NULL OR p.id <> p_exclude_staff_id)
  ORDER BY p.name
  LIMIT 1;

  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_pin_holder(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_pin_holder(text, uuid) TO authenticated, service_role;

-- Permissions the transfer confirmation and dispute prompts check; the same
-- roles the RPCs already require.
INSERT INTO role_permissions (role, action) VALUES
  ('manager', 'confirm_transfer_payment'),
  ('admin', 'confirm_transfer_payment'),
  ('manager', 'dispute_transfer_payment'),
  ('admin', 'dispute_transfer_payment')
ON CONFLICT (role, action) DO NOTHING;

NOTIFY pgrst, 'reload schema';
