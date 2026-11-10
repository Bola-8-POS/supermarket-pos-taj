-- Offline approval grants: bind at issue, cap validity, never an online approval
-- (review finding M1 and the Opus review that followed).
--
-- Before: a grant id was a pure bearer token that resolve_manager_approval
-- accepted online, so the cashier holding one could call a gated RPC (e.g.
-- reopen_tab, process_refund) with no manager present.
--
-- 1. resolve_manager_approval is again just resolve_approval_ticket (the
--    20260922000004 behaviour): the server NEVER honours a grant as an approval,
--    whatever its action, age or binding, including rows issued earlier (fail
--    closed). Grants are client-side offline tokens (the till redeems them while
--    offline) that are only reported afterwards. Signature, SECURITY DEFINER,
--    search_path and the service_role-only privileges are unchanged
--    (CREATE OR REPLACE keeps them).
-- 2. offline_approval_grants.requested_for: auth.uid() at issue, i.e. the
--    till's signed-in cashier whose request the manager PIN approved. Nullable
--    only so old rows survive the ALTER; no ON DELETE action, matching
--    granted_by's plain REFERENCES.
-- 3. issue_offline_approval_grants: only reopen_tab (the sole GRANTABLE_ACTIONS
--    entry in the UI) can be issued; validity 1-240 minutes (was 1-720); stamps
--    and audits requested_for. Count cap 1-10 and the signature are unchanged.
--    Widen the allow-list only together with the UI.
-- 4. report_offline_approvals: the caller must be the grant's requested_for and
--    must be the usedBy it names (AUTH_FORBIDDEN otherwise), so nobody can
--    retire another cashier's grants or attribute a use to another profile.
--    Legacy rows (requested_for NULL) and unknown/reported ids are skipped.
--
-- Not bound server-side: terminal_id (never checked, no approval path uses it)
-- and a refund ceiling (no refund grant can exist any more).

ALTER TABLE public.offline_approval_grants ADD COLUMN IF NOT EXISTS requested_for uuid REFERENCES public.profiles (id);

CREATE OR REPLACE FUNCTION public.resolve_manager_approval(p_approval_id uuid, p_approver_id uuid, p_action text, p_caller_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN resolve_approval_ticket(p_approval_id, p_approver_id, p_action, p_caller_id);
END;
$$;

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
  IF p_action IS DISTINCT FROM 'reopen_tab' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: % cannot be approved offline', p_action;
  END IF;
  IF p_count IS NULL OR p_count NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: grant count must be between 1 and 10';
  END IF;
  IF p_valid_minutes IS NULL OR p_valid_minutes NOT BETWEEN 1 AND 240 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: grant validity must be between 1 and 240 minutes';
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
    INSERT INTO offline_approval_grants (action, terminal_id, granted_by, requested_for, expires_at)
    SELECT p_action, p_terminal_id, v_approver, v_uid, now() + make_interval(mins => p_valid_minutes)
    FROM generate_series(1, p_count)
    RETURNING id, action, terminal_id, granted_by, requested_for, expires_at
  )
  SELECT jsonb_agg(jsonb_build_object(
    'id', id, 'action', action, 'terminal_id', terminal_id, 'granted_by', granted_by,
    'requested_for', requested_for, 'expires_at', expires_at
  ))
  INTO v_grants
  FROM ins;

  -- Count only, never the grant ids (they are bearer values readable via audit_logs).
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
      'requested_for', v_uid
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

    SELECT * INTO v_grant FROM offline_approval_grants WHERE id = v_id AND reported_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_grant.requested_for IS NULL THEN
      CONTINUE;
    END IF;
    IF v_grant.requested_for <> v_uid OR v_used_by IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'AUTH_FORBIDDEN: an offline use can only be reported by the cashier it was issued to';
    END IF;

    UPDATE offline_approval_grants
    SET reported_at = now(),
        consumed_at = COALESCE(consumed_at, now()),
        consumed_by = COALESCE(consumed_by, v_uid)
    WHERE id = v_grant.id;

    PERFORM record_audit(
      'approval.offline_used',
      'offline_approval_grant',
      v_grant.id,
      NULL,
      jsonb_build_object(
        'offline_approval', true,
        'action', v_grant.action,
        'granted_by', v_grant.granted_by,
        'requested_for', v_grant.requested_for,
        'used_by', v_uid,
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
