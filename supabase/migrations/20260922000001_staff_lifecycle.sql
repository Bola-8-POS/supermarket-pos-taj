-- Staff lifecycle.
--
-- 1. get_user_role() returns a role for an active profile only, so every
--    role-gated policy and RPC refuses a deactivated staff member's session.
-- 2. force_pin_change requires an active caller.
-- 3. set_staff_active flips a staff member's active state under a lock, keeps
--    at least one active admin, and records the change. Service role only;
--    the set-staff-active edge function is its caller.

CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT role FROM profiles WHERE id = auth.uid() AND is_active = true;
$$;

CREATE OR REPLACE FUNCTION public.force_pin_change(p_staff_id uuid, p_terminal_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  -- 1. Verify caller is an active manager or admin
  SELECT id INTO v_caller FROM profiles
  WHERE id = auth.uid()
    AND role IN ('manager', 'admin')
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  -- 2. Capture before state; NOT_FOUND if the target staff does not exist
  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'locale', p.locale,
                            'must_change_pin', p.must_change_pin, 'is_active', p.is_active)
    INTO v_before FROM profiles p WHERE p.id = p_staff_id;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: staff % not found', p_staff_id;
  END IF;

  -- 3. Flag the staff member
  UPDATE profiles SET must_change_pin = true WHERE id = p_staff_id;

  -- 4. Capture after state + audit
  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'locale', p.locale,
                            'must_change_pin', p.must_change_pin, 'is_active', p.is_active)
    INTO v_after FROM profiles p WHERE p.id = p_staff_id;

  PERFORM record_audit(
    'permission.force_pin_change',
    'staff',
    p_staff_id,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- Returns {ok:true, changed} or {ok:false, code:'NOT_FOUND'|'SELF'|'LAST_ADMIN'}.
CREATE FUNCTION public.set_staff_active(
  p_staff_id    uuid,
  p_active      boolean,
  p_actor_id    uuid,
  p_terminal_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role      user_role;
  v_is_active boolean;
BEGIN
  -- One activation change at a time, so the last-admin rule holds under
  -- concurrent calls.
  PERFORM pg_advisory_xact_lock(hashtext('staff_active'));

  SELECT p.role, p.is_active INTO v_role, v_is_active
  FROM profiles p WHERE p.id = p_staff_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF p_staff_id = p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SELF');
  END IF;

  IF NOT p_active AND v_is_active AND v_role = 'admin'
     AND NOT EXISTS (SELECT 1 FROM profiles WHERE role = 'admin' AND is_active = true AND id <> p_staff_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LAST_ADMIN');
  END IF;

  IF v_is_active = p_active THEN
    RETURN jsonb_build_object('ok', true, 'changed', false);
  END IF;

  UPDATE profiles
  SET is_active  = p_active,
      deleted_at = CASE WHEN p_active THEN NULL ELSE now() END,
      updated_at = now()
  WHERE id = p_staff_id;

  PERFORM record_audit(
    CASE WHEN p_active THEN 'staff.reactivate' ELSE 'staff.deactivate' END,
    'staff',
    p_staff_id,
    jsonb_build_object('is_active', v_is_active),
    jsonb_build_object('is_active', p_active),
    'edge',
    p_terminal_id,
    p_actor_id
  );

  RETURN jsonb_build_object('ok', true, 'changed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_staff_active(uuid, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_staff_active(uuid, boolean, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
