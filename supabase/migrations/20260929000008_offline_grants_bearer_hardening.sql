-- Offline approval grants: stop leaking live grant ids (offline-first Plan 03,
-- final-review finding 4).
--
-- A grant id is a bearer approval: any signed-in session that presents one to
-- a gated RPC is approved as the issuing manager. Two places exposed live ids
-- in audit_logs, which managers and admins can read and export:
--
-- 1. issue_offline_approval_grants recorded every new grant id in its audit
--    row. It now records the count only.
-- 2. report_offline_approvals audited a reported use with the grant id as
--    entity_id but left the grant unconsumed, so the id stayed redeemable
--    until expiry. Reporting now also consumes the grant (if an RPC has not
--    already), so an id that reaches the audit log authorises nothing. This is
--    safe because offline redemption is only offered at gates whose action
--    completes offline (ManagerPinDialog offlineCapable) — none of them sends
--    the grant to a gated RPC that could still need it after reconnect.
--    The reported staff member is accepted only when it names a real profile;
--    otherwise the reporter is recorded.
--
-- Signatures are unchanged, so CREATE OR REPLACE keeps the existing grants.

CREATE OR REPLACE FUNCTION public.issue_offline_approval_grants(
  p_approval_id   uuid,
  p_approver_id   uuid,
  p_action        text,
  p_count         integer,
  p_valid_minutes integer,
  p_terminal_id   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_res      jsonb;
  v_approver uuid;
  v_grants   jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('process_refund', 'reopen_tab', 'edit_paid_tab', 'apply_custom_discount') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: % cannot be approved offline', p_action;
  END IF;
  IF p_count IS NULL OR p_count NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: grant count must be between 1 and 10';
  END IF;
  IF p_valid_minutes IS NULL OR p_valid_minutes NOT BETWEEN 1 AND 720 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: grant validity must be between 1 and 720 minutes';
  END IF;
  IF p_terminal_id IS NULL OR p_terminal_id !~ '^[A-Za-z0-9_-]{1,32}$' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: invalid terminal id';
  END IF;

  -- An online ticket only: a grant must never be able to issue more grants.
  v_res := resolve_approval_ticket(p_approval_id, p_approver_id, p_action, v_uid);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'APPROVAL_REQUIRED: %', COALESCE(v_res->>'code', 'INVALID_APPROVAL');
  END IF;
  v_approver := (v_res->>'approver_id')::uuid;

  DELETE FROM offline_approval_grants WHERE expires_at < now() - interval '30 days';

  WITH ins AS (
    INSERT INTO offline_approval_grants (action, terminal_id, granted_by, expires_at)
    SELECT p_action, p_terminal_id, v_approver, now() + make_interval(mins => p_valid_minutes)
    FROM generate_series(1, p_count)
    RETURNING id, action, terminal_id, granted_by, expires_at
  )
  SELECT jsonb_agg(jsonb_build_object(
    'id', id, 'action', action, 'terminal_id', terminal_id, 'granted_by', granted_by, 'expires_at', expires_at
  ))
  INTO v_grants
  FROM ins;

  PERFORM record_audit(
    'approval.offline_grants_issued',
    'offline_approval_grant',
    NULL,
    NULL,
    jsonb_build_object(
      'action', p_action,
      'count', p_count,
      'valid_minutes', p_valid_minutes,
      'granted_by', v_approver
    ),
    'rpc',
    p_terminal_id
  );
  RETURN v_grants;
END;
$$;

CREATE OR REPLACE FUNCTION public.report_offline_approvals(p_uses jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_use     jsonb;
  v_id      uuid;
  v_used_by uuid;
  v_used_at timestamptz;
  v_grant   offline_approval_grants%ROWTYPE;
  v_count   integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  IF jsonb_typeof(p_uses) IS DISTINCT FROM 'array' OR jsonb_array_length(p_uses) > 100 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: p_uses must be an array of at most 100 entries';
  END IF;

  FOR v_use IN SELECT * FROM jsonb_array_elements(p_uses) LOOP
    BEGIN
      v_id := (v_use->>'grantId')::uuid;
      v_used_at := to_timestamp((v_use->>'usedAt')::bigint / 1000.0);
      v_used_by := (v_use->>'usedBy')::uuid;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
      CONTINUE;
    END;
    -- Only a real staff member may be named; otherwise attribute to the reporter.
    SELECT id INTO v_used_by FROM profiles WHERE id = v_used_by;
    v_used_by := COALESCE(v_used_by, v_uid);

    UPDATE offline_approval_grants
    SET reported_at = now(),
        consumed_at = COALESCE(consumed_at, now()),
        consumed_by = COALESCE(consumed_by, v_used_by)
    WHERE id = v_id AND reported_at IS NULL
    RETURNING * INTO v_grant;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    PERFORM record_audit(
      'approval.offline_used',
      'offline_approval_grant',
      v_grant.id,
      NULL,
      jsonb_build_object(
        'offline_approval', true,
        'action', v_grant.action,
        'granted_by', v_grant.granted_by,
        'used_by', v_used_by,
        'used_at_local', v_used_at,
        'reported_by', v_uid
      ),
      'rpc',
      v_grant.terminal_id
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
