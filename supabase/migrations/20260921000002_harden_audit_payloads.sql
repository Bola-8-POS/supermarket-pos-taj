-- Harden audit payloads.
--
-- 1. Payloads recorded for staff changes are built from an explicit column
--    list.
-- 2. record_audit removes credential-like keys from any payload it stores.
-- 3. Only the service role may name the recorded actor; every other caller is
--    recorded as itself.

CREATE OR REPLACE FUNCTION public.audit_redact(p_payload jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE jsonb_typeof(p_payload)
    WHEN 'object' THEN COALESCE(
      (SELECT jsonb_object_agg(e.key, public.audit_redact(e.value))
         FROM jsonb_each(p_payload) AS e
        WHERE e.key <> ALL (ARRAY['pin', 'old_pin', 'new_pin', 'manager_pin'])),
      '{}'::jsonb)
    WHEN 'array' THEN COALESCE(
      (SELECT jsonb_agg(public.audit_redact(e.value) ORDER BY e.ord)
         FROM jsonb_array_elements(p_payload) WITH ORDINALITY AS e(value, ord)),
      '[]'::jsonb)
    ELSE p_payload
  END
$$;

CREATE OR REPLACE FUNCTION public.record_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid DEFAULT NULL::uuid,
  p_before jsonb DEFAULT NULL::jsonb,
  p_after jsonb DEFAULT NULL::jsonb,
  p_source text DEFAULT 'rpc'::text,
  p_terminal_id text DEFAULT NULL::text,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_id   uuid;
  v_before     jsonb;
  v_after      jsonb;
  v_log_id     uuid;
BEGIN
  v_before := public.audit_redact(p_before);
  v_after := public.audit_redact(p_after);

  -- Only the service role may name the actor (trusted server paths); every
  -- other caller is recorded as the authenticated user.
  -- A plain database session without JWT claims (auth.role() NULL) gets a NULL actor.
  IF auth.role() = 'service_role' THEN
    v_actor_id := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor_id := auth.uid();
  END IF;

  -- Truncate oversized payloads (>64KB) with marker
  IF pg_column_size(v_before) > 65536 THEN
    v_before := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;
  IF pg_column_size(v_after) > 65536 THEN
    v_after := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;

  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after, source, terminal_id)
  VALUES (v_actor_id, p_action, p_entity_type, p_entity_id, v_before, v_after, p_source, p_terminal_id)
  RETURNING id INTO v_log_id;

  RETURN v_log_id;

EXCEPTION WHEN OTHERS THEN
  -- Audit failure must NEVER fail the primary action
  -- Log to PostgreSQL server log for DBA visibility
  RAISE WARNING 'record_audit failed: % %', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_own_locale(p_locale text, p_terminal_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  v_uid := auth.uid();

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;

  IF p_locale NOT IN ('es-MX', 'en-US') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: unsupported locale %', p_locale;
  END IF;

  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'locale', p.locale,
                            'must_change_pin', p.must_change_pin, 'is_active', p.is_active)
    INTO v_before FROM profiles p WHERE p.id = v_uid;

  UPDATE profiles SET locale = p_locale WHERE id = v_uid;

  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'locale', p.locale,
                            'must_change_pin', p.must_change_pin, 'is_active', p.is_active)
    INTO v_after FROM profiles p WHERE p.id = v_uid;

  PERFORM record_audit(
    'staff.locale_change',
    'staff',
    v_uid,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$function$;

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
  -- 1. Verify caller is manager or admin
  SELECT id INTO v_caller FROM profiles
  WHERE id = auth.uid()
    AND role IN ('manager', 'admin');

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

CREATE OR REPLACE FUNCTION public.clear_must_change_pin(p_new_pin text, p_terminal_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  v_uid := auth.uid();

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;

  IF p_new_pin !~ '^\d{6}$' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: PIN must be exactly 6 digits';
  END IF;

  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'locale', p.locale,
                            'must_change_pin', p.must_change_pin, 'is_active', p.is_active)
    INTO v_before FROM profiles p WHERE p.id = v_uid;

  UPDATE profiles
  SET pin = p_new_pin,
      must_change_pin = false
  WHERE id = v_uid;

  SELECT jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role, 'locale', p.locale,
                            'must_change_pin', p.must_change_pin, 'is_active', p.is_active)
    INTO v_after FROM profiles p WHERE p.id = v_uid;

  PERFORM record_audit(
    'permission.force_pin_change',
    'staff',
    v_uid,
    v_before,
    v_after,
    'rpc',
    p_terminal_id
  );

  RETURN jsonb_build_object('ok', true);
END;
$function$;
