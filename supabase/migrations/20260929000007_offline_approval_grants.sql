-- Offline approval grants (offline-first Plan 03; decision record
-- docs/superpowers/specs/2026-09-29-offline-approval-scope.md).
--
-- A terminal with no connectivity cannot obtain the 15-minute approval ticket
-- verify_staff_pin issues. Instead, a manager, while online, issues a few
-- single-use grants for one action to one terminal; offline, the signed-in
-- staff member redeems one, and its id travels in p_approval_id exactly where
-- a ticket id would.
--
-- 1. offline_approval_grants: one row per grant. Service role only.
-- 2. resolve_approval_ticket: the previous body of resolve_manager_approval,
--    unchanged — online tickets only.
-- 3. resolve_manager_approval (same signature, so none of the six gated RPCs
--    change): a ticket first; failing that, an unused, unexpired grant for the
--    action whose issuer is still active and still holds it. The grant is
--    consumed inside the caller's transaction and audited as offline; the
--    issuer is returned as the approver. Each gated RPC's idempotency check
--    runs before this call, so a replay does not consume a second grant.
-- 4. issue_offline_approval_grants: consumes an online ticket (never a grant,
--    so grants cannot mint grants) and inserts 1-10 grants valid 1-720 minutes.
-- 5. report_offline_approvals: on reconnect the terminal reports each offline
--    use; each grant is audited once, with the local time of use. Reporting
--    does not consume — a sale approved offline and retried after reconnect
--    must still pass its RPC.

CREATE TABLE public.offline_approval_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action      text NOT NULL CHECK (action IN ('process_refund', 'reopen_tab', 'edit_paid_tab', 'apply_custom_discount')),
  terminal_id text NOT NULL,
  granted_by  uuid NOT NULL REFERENCES public.profiles (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by uuid,
  reported_at timestamptz
);
ALTER TABLE public.offline_approval_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.offline_approval_grants FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.offline_approval_grants TO service_role;

-- Online tickets only: the body of 20260922000004's resolve_manager_approval.
CREATE FUNCTION public.resolve_approval_ticket(p_approval_id uuid, p_approver_id uuid, p_action text, p_caller_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids      uuid[];
  v_approver uuid;
BEGIN
  IF p_caller_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  IF p_approval_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'APPROVAL_REQUIRED');
  END IF;

  SELECT approver_ids INTO v_ids
  FROM manager_approvals
  WHERE id = p_approval_id
    AND caller_id = p_caller_id
    AND action = p_action
    AND consumed_at IS NULL
    AND created_at > now() - interval '15 minutes'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_APPROVAL');
  END IF;

  IF p_approver_id IS NOT NULL THEN
    IF NOT (p_approver_id = ANY (v_ids)) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_APPROVAL');
    END IF;
    v_approver := p_approver_id;
  ELSIF cardinality(v_ids) = 1 THEN
    v_approver := v_ids[1];
  ELSE
    RETURN jsonb_build_object('ok', false, 'code', 'AMBIGUOUS_APPROVAL');
  END IF;

  -- The approver must still be active and still hold the action when the ticket is used.
  IF NOT EXISTS (
    SELECT 1 FROM profiles p
    JOIN role_permissions rp ON rp.role = p.role
    WHERE p.id = v_approver AND p.is_active = true AND rp.action = p_action
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_APPROVAL');
  END IF;

  UPDATE manager_approvals SET consumed_at = now() WHERE id = p_approval_id;
  RETURN jsonb_build_object('ok', true, 'approver_id', v_approver);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_approval_ticket(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_approval_ticket(uuid, uuid, text, uuid) TO service_role;

-- Ticket first, then an offline grant. A grant names its own approver (the
-- issuer), so p_approver_id plays no part on that path.
CREATE OR REPLACE FUNCTION public.resolve_manager_approval(p_approval_id uuid, p_approver_id uuid, p_action text, p_caller_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res   jsonb;
  v_grant offline_approval_grants%ROWTYPE;
BEGIN
  v_res := resolve_approval_ticket(p_approval_id, p_approver_id, p_action, p_caller_id);
  IF v_res->>'code' IS DISTINCT FROM 'INVALID_APPROVAL' THEN
    RETURN v_res;
  END IF;

  SELECT * INTO v_grant
  FROM offline_approval_grants
  WHERE id = p_approval_id
    AND action = p_action
    AND consumed_at IS NULL
    AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN v_res;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles p
    JOIN role_permissions rp ON rp.role = p.role
    WHERE p.id = v_grant.granted_by AND p.is_active = true AND rp.action = p_action
  ) THEN
    RETURN v_res;
  END IF;

  UPDATE offline_approval_grants SET consumed_at = now(), consumed_by = p_caller_id WHERE id = v_grant.id;
  PERFORM record_audit(
    'approval.offline_grant_consumed',
    'offline_approval_grant',
    v_grant.id,
    NULL,
    jsonb_build_object(
      'offline_approval', true,
      'action', p_action,
      'granted_by', v_grant.granted_by,
      'consumed_by', p_caller_id
    ),
    'rpc',
    v_grant.terminal_id
  );
  RETURN jsonb_build_object('ok', true, 'approver_id', v_grant.granted_by, 'offline', true);
END;
$$;

CREATE FUNCTION public.issue_offline_approval_grants(
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
      'granted_by', v_approver,
      'grant_ids', (SELECT jsonb_agg(g->'id') FROM jsonb_array_elements(v_grants) g)
    ),
    'rpc',
    p_terminal_id
  );
  RETURN v_grants;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_offline_approval_grants(uuid, uuid, text, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_offline_approval_grants(uuid, uuid, text, integer, integer, text) TO authenticated, service_role;

-- p_uses: [{grantId, usedBy, usedAt (epoch ms)}], as logged by the terminal.
-- Unknown, already-reported or malformed entries are skipped. Returns the
-- number of uses recorded.
CREATE FUNCTION public.report_offline_approvals(p_uses jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_use     jsonb;
  v_id      uuid;
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
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
      CONTINUE;
    END;

    UPDATE offline_approval_grants SET reported_at = now()
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
        'used_by', v_use->>'usedBy',
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

REVOKE ALL ON FUNCTION public.report_offline_approvals(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_offline_approvals(jsonb) TO authenticated, service_role;
