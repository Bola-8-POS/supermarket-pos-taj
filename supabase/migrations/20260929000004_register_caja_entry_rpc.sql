-- Manual cash in/out moved from a bare client insert into caja_entries to an RPC, so it can
-- carry an idempotency key. A replayed insert previously created a second, fully independent
-- cash movement with nothing in the schema to catch it, silently corrupting the register count
-- (recon R2 §B6).
--
-- AUTHORIZATION PARITY (controller ruling #1): register_caja_entry is SECURITY DEFINER, which
-- bypasses RLS entirely -- so the client's direct insert's authorization has to be reproduced
-- explicitly inside the function, or any authenticated caller (e.g. a cashier) could register
-- cash movements that RLS forbids them from writing today. The effective policy, confirmed via
-- `select policyname, cmd, qual, with_check from pg_policies where tablename='caja_entries'` on
-- supabase_db_supermarket-pos-dev2 (the 20260421000003 policy of the same name was superseded by
-- this one in 20260510000001_rls_rewrite_phase13.sql and never touched again by any later
-- migration -- confirmed by grepping every migration that mentions caja_entries):
--
--   CREATE POLICY "caja_entries_insert_manager_admin" ON caja_entries
--     FOR INSERT TO authenticated
--     WITH CHECK (
--       EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_caja')
--     );
--
-- This is an RBAC-table lookup, not a hardcoded role check (role_permissions is admin-editable
-- via the toggle-permission RBAC action) -- by default only manager/admin hold 'manage_caja'
-- (confirmed via `select role, action from role_permissions where action='manage_caja'` on the
-- same instance: manager, admin). The function below reproduces that exact predicate with
-- `EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_caja')`
-- and raises AUTH_FORBIDDEN when it fails, so an unauthorized caller is rejected the same way RLS
-- would have rejected their direct insert. Per controller ruling #2, this authorization check
-- runs BEFORE idempotency_begin (an unauthorized caller must learn nothing from the replay
-- ledger) and idempotency_begin runs BEFORE the insert.
--
-- Column list confirmed via `\d caja_entries` on dev2 and matched exactly: caja_session_id,
-- type, amount, concept, staff_id, source. staff_id is taken from auth.uid() (the authenticated
-- caller) rather than a client-supplied parameter -- every staff member is a real Supabase Auth
-- user signed in via PIN login (CLAUDE.md "PIN/password has two separate credential stores"), so
-- auth.uid() is always the same value the client used to pass as staffId, just no longer
-- spoofable. `type`'s real CHECK constraint is ('expense', 'income') -- NOT ('cash_in',
-- 'cash_out') as the task brief's illustrative snippet assumed; confirmed via `\d caja_entries`
-- and matched here. `source` defaults to 'manual' and is set explicitly to document intent,
-- matching what a manual entry means for reopen_tab/edit_paid_tab's own 'reopen'/'edit' source
-- values (20260925000003_caja_cash_and_refund_attribution.sql).
--
-- CAJA_CLOSED is new hardening, not a behavior change from the old client insert: the old bare
-- insert had no server-side check of the named session's status at all (only the RLS role check
-- above), so this closes a real gap where a stale client could write into an already-closed
-- session's drawer.

CREATE OR REPLACE FUNCTION public.register_caja_entry(
  p_caja_session_id uuid,
  p_type            text,
  p_amount          numeric,
  p_concept         text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_status   text;
  v_replay   jsonb;
  v_entry_id uuid;
  v_scope    text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: no authenticated caller';
  END IF;
  IF p_type NOT IN ('expense', 'income') THEN
    RAISE EXCEPTION 'INVALID_TYPE: type must be expense or income';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: amount must be greater than zero';
  END IF;
  IF p_concept IS NULL OR btrim(p_concept) = '' OR char_length(p_concept) > 200 THEN
    RAISE EXCEPTION 'INVALID_CONCEPT: concept must be 1-200 characters';
  END IF;

  -- Authorization parity with caja_entries_insert_manager_admin (see header note above).
  -- Runs before the idempotency check so an unauthorized caller never learns anything from
  -- the replay ledger.
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_caja'
  ) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manage_caja permission required';
  END IF;

  v_scope := p_caja_session_id::text || '|' || p_type || '|' || p_amount::text || '|' || p_concept;
  v_replay := public.idempotency_begin(p_idempotency_key, 'register_caja_entry', v_caller, v_scope);
  IF v_replay IS NOT NULL THEN
    RETURN v_replay || jsonb_build_object('idempotent', true);
  END IF;

  SELECT status INTO v_status FROM caja_sessions WHERE id = p_caja_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: caja session does not exist';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'CAJA_CLOSED: caja session is not open';
  END IF;

  INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id, source)
  VALUES (p_caja_session_id, p_type, p_amount, p_concept, v_caller, 'manual')
  RETURNING id INTO v_entry_id;

  PERFORM public.idempotency_commit(
    p_idempotency_key, 'register_caja_entry', v_caller, v_scope,
    jsonb_build_object('ok', true, 'entryId', v_entry_id)
  );

  RETURN jsonb_build_object('ok', true, 'entryId', v_entry_id);
END;
$$;

REVOKE ALL ON FUNCTION public.register_caja_entry(uuid, text, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_caja_entry(uuid, text, numeric, text, text) TO authenticated, service_role;
