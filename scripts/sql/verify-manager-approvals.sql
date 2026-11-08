\set ON_ERROR_STOP on
-- Assertions: manager approvals on the override RPCs.
-- Run as the migration role:
--   psql -v ON_ERROR_STOP=1 < scripts/sql/verify-manager-approvals.sql
-- Static catalog checks only; behavior lives in
-- src/entities/payment/model/manager-approvals.integration.test.ts.
DO $$
DECLARE
  v_bad   text;
  v_names text[] := ARRAY['process_refund', 'reopen_tab', 'edit_paid_tab',
                          'process_payment_atomic', 'process_split_payment_atomic',
                          'process_direct_sale_atomic'];
  v_name  text;
BEGIN
  -- 1. payments.approved_by exists, is a nullable uuid and references profiles.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'approved_by'
      AND data_type = 'uuid' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'payments.approved_by missing or wrong type';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.payments'::regclass AND c.contype = 'f'
      AND c.confrelid = 'public.profiles'::regclass
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.payments'::regclass AND attname = 'approved_by')]
  ) THEN
    RAISE EXCEPTION 'payments.approved_by does not reference profiles';
  END IF;

  -- 2. The approval helper exists once, is callable by the service role only, and consumes a ticket.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'resolve_manager_approval') <> 1 THEN
    RAISE EXCEPTION 'resolve_manager_approval must exist exactly once';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_manager_approval(uuid, uuid, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_manager_approval(uuid, uuid, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.resolve_manager_approval(uuid, uuid, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'resolve_manager_approval privileges are wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.resolve_manager_approval(uuid, uuid, text, uuid)'::regprocedure
                 AND prosrc LIKE '%manager_approvals%' AND prosrc LIKE '%consumed_at%' AND prosrc LIKE '%role_permissions%') THEN
    RAISE EXCEPTION 'resolve_manager_approval does not consume a ticket or apply the role rule';
  END IF;

  -- 3. Each override RPC exists once, takes p_approval_id (no PIN argument) and p_approver_id last,
  --    resolves through the helper, no longer compares a pin column itself, and names the approver in what it records.
  --    process_refund (wave 3c) is the one exception: it gains a sixth
  --    argument, p_caja_session_id, after p_approver_id.
  FOREACH v_name IN ARRAY v_names LOOP
    IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name) <> 1 THEN
      RAISE EXCEPTION '% must exist exactly once (an extra overload breaks PostgREST)', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name
                   AND (pg_get_function_identity_arguments(oid) LIKE '%p_approver_id uuid'
                        OR (v_name = 'process_refund' AND pg_get_function_identity_arguments(oid) LIKE '%p_approver_id uuid, p_caja_session_id uuid'))) THEN
      RAISE EXCEPTION '% does not take p_approver_id as its last argument (or, for process_refund, second-to-last)', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name
                   AND pg_get_function_identity_arguments(oid) LIKE '%p_approval_id uuid%'
                   AND pg_get_function_identity_arguments(oid) NOT LIKE '%p_manager_pin%') THEN
      RAISE EXCEPTION '% does not take p_approval_id in place of a PIN argument', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name
                   AND prosrc LIKE '%resolve_manager_approval(%') THEN
      RAISE EXCEPTION '% does not resolve the approver through the helper', v_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name
               AND prosrc ~ '\.pin\s*=') THEN
      RAISE EXCEPTION '% still compares a pin column itself', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name
                   AND prosrc LIKE '%approved_by%') THEN
      RAISE EXCEPTION '% does not record the approver', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name
                   AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION '% does not pin search_path to public, pg_temp', v_name;
    END IF;
  END LOOP;

  -- 4. The direct-sale RPC hands its resolved approver to the payment RPCs it delegates to,
  --    and both of them honor it.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'process_direct_sale_atomic'
                 AND prosrc LIKE '%set_config(''app.manager_approver_id''%') THEN
    RAISE EXCEPTION 'process_direct_sale_atomic does not pass its approver to the payment RPCs';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['process_payment_atomic', 'process_split_payment_atomic'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = v_name
                   AND prosrc LIKE '%current_setting(''app.manager_approver_id''%') THEN
      RAISE EXCEPTION '% does not read the approver handed down by the direct-sale RPC', v_name;
    END IF;
  END LOOP;

  -- 5. Privileges: the three prompt RPCs stay callable by signed-in staff, the three checkout RPCs
  --    by the service role only, none by anon.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_names)
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
         OR (p.proname IN ('process_refund', 'reopen_tab', 'edit_paid_tab')
             AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
         OR (p.proname IN ('process_payment_atomic', 'process_split_payment_atomic', 'process_direct_sale_atomic')
             AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'override RPC privileges wrong on: %', v_bad;
  END IF;

  -- 6. The ticket table has RLS on and the client roles cannot touch it,
  --    at table level or on any column (DELETE has no column form).
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.manager_approvals'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'manager_approvals does not have row level security enabled';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.manager_approvals', v_name)
       OR has_table_privilege('authenticated', 'public.manager_approvals', v_name) THEN
      RAISE EXCEPTION 'a client role holds % on manager_approvals', v_name;
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
    IF has_any_column_privilege('anon', 'public.manager_approvals', v_name)
       OR has_any_column_privilege('authenticated', 'public.manager_approvals', v_name) THEN
      RAISE EXCEPTION 'a client role holds % on a manager_approvals column', v_name;
    END IF;
  END LOOP;

  -- 7. The PIN check issues the ticket.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'verify_staff_pin'
                 AND prosrc LIKE '%INSERT INTO manager_approvals%') THEN
    RAISE EXCEPTION 'verify_staff_pin does not issue an approval ticket';
  END IF;
END $$;
SELECT 'verify-manager-approvals: ok' AS result;
