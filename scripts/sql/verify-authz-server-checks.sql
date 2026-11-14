\set ON_ERROR_STOP on
-- Assertions: server-side checks added for the live role_permissions matrix.
-- Run as postgres: psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/sql/verify-authz-server-checks.sql
-- Read-only. Collects every failing check into an array and raises once at
-- the end naming them all, so a RED run shows every failing check in one go
-- instead of stopping at the first one.
DO $$
DECLARE
  v_failed text[] := '{}';
  v_src text;
BEGIN
  -- 1. process_direct_sale_atomic requires the caller to hold create_order.
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'process_direct_sale_atomic';
  IF v_src IS NULL OR v_src NOT LIKE '%rp.action = ''create_order''%' THEN
    v_failed := array_append(v_failed, 'process_direct_sale_atomic missing the create_order check');
  END IF;

  -- 2. confirm_transfer_payment / dispute_transfer_payment read
  --    role_permissions and no longer hard-code role IN (...).
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'confirm_transfer_payment';
  IF v_src IS NULL
     OR v_src NOT LIKE '%rp.action = ''confirm_transfer_payment''%'
     OR v_src LIKE '%role IN (%' THEN
    v_failed := array_append(v_failed, 'confirm_transfer_payment still hard-codes a role list');
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'dispute_transfer_payment';
  IF v_src IS NULL
     OR v_src NOT LIKE '%rp.action = ''dispute_transfer_payment''%'
     OR v_src LIKE '%role IN (%' THEN
    v_failed := array_append(v_failed, 'dispute_transfer_payment still hard-codes a role list');
  END IF;

  -- 3. agent_audit_log's INSERT policy binds user_id to the writing session.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.agent_audit_log'::regclass
      AND polname = 'agent_audit_log_insert_authenticated'
      AND pg_get_expr(polwithcheck, polrelid) LIKE '%auth.uid()%'
  ) THEN
    v_failed := array_append(v_failed, 'agent_audit_log insert policy does not name auth.uid()');
  END IF;

  -- 4. The unused code-index objects and the vector extension are gone.
  IF to_regprocedure('public.match_codebase_chunks(vector, integer, double precision)') IS NOT NULL THEN
    v_failed := array_append(v_failed, 'match_codebase_chunks still exists');
  END IF;
  IF to_regclass('public.pos_codebase_index') IS NOT NULL THEN
    v_failed := array_append(v_failed, 'pos_codebase_index still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    v_failed := array_append(v_failed, 'vector extension still installed');
  END IF;

  -- 5. The three re-created functions keep search_path = public, pg_temp.
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('process_direct_sale_atomic', 'confirm_transfer_payment', 'dispute_transfer_payment')
      AND NOT ('search_path=public, pg_temp' = ANY (coalesce(proconfig, '{}')))
  ) THEN
    v_failed := array_append(v_failed, 'a re-created function lost search_path = public, pg_temp');
  END IF;

  IF array_length(v_failed, 1) > 0 THEN
    RAISE EXCEPTION 'verify-authz-server-checks failed: %', array_to_string(v_failed, '; ');
  END IF;
END $$;
SELECT 'verify-authz-server-checks: ok' AS result;
