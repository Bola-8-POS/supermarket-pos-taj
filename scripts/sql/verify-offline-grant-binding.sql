-- Offline approval grants (20261103000001). Run against LOCAL dev2 only; rolls back.
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 56322 -U postgres -d postgres -v ON_ERROR_STOP=1 -f scripts/sql/verify-offline-grant-binding.sql
-- Asserts: the server never honours a grant as an approval; issue allow-list,
-- TTL/count caps, requested_for + audit; report ownership; tickets still work.
-- Prints "ALL PASS" or fails on the first broken case.
BEGIN;
DO $$
DECLARE
  mgr uuid; a uuid; b uuid; t uuid; g jsonb; gid uuid; r jsonb; n int; act text;
BEGIN
  SELECT p.id INTO mgr FROM profiles p JOIN role_permissions rp ON rp.role = p.role
    WHERE p.is_active AND rp.action = 'process_refund' AND p.role = 'manager' LIMIT 1;
  SELECT id INTO a FROM profiles WHERE role = 'cashier' AND is_active ORDER BY id LIMIT 1;
  SELECT id INTO b FROM profiles WHERE role = 'cashier' AND is_active AND id <> a ORDER BY id LIMIT 1;
  IF mgr IS NULL OR a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'fixture profiles missing'; END IF;
  PERFORM set_config('request.jwt.claim.sub', a::text, true);

  -- Issue as cashier A on a manager ticket: bound, audited.
  INSERT INTO manager_approvals (caller_id, action, approver_ids) VALUES (a, 'reopen_tab', ARRAY[mgr]) RETURNING id INTO t;
  g := issue_offline_approval_grants(t, mgr, 'reopen_tab', 2, 240, 'T-1');
  IF jsonb_array_length(g) <> 2 OR (g->0->>'requested_for')::uuid <> a THEN RAISE EXCEPTION 'grant not bound to requester'; END IF;
  SELECT count(*) INTO n FROM audit_logs WHERE action = 'approval.offline_grants_issued' AND after->>'requested_for' = a::text;
  IF n < 1 THEN RAISE EXCEPTION 'issue audit row missing requested_for'; END IF;

  -- The server never honours a grant as an approval: bound or legacy, own or other user, any action.
  FOREACH act IN ARRAY ARRAY['reopen_tab', 'process_refund', 'edit_paid_tab', 'apply_custom_discount'] LOOP
    FOREACH n IN ARRAY ARRAY[0, 1] LOOP
      INSERT INTO offline_approval_grants (action, terminal_id, granted_by, requested_for, expires_at)
        VALUES (act, 'T-1', mgr, CASE WHEN n = 0 THEN a ELSE NULL END, now() + interval '1 hour') RETURNING id INTO gid;
      r := resolve_manager_approval(gid, NULL, act, a);
      IF COALESCE((r->>'ok')::boolean, false) THEN RAISE EXCEPTION '% grant (bound=%) honoured for its cashier', act, n = 0; END IF;
      r := resolve_manager_approval(gid, NULL, act, b);
      IF COALESCE((r->>'ok')::boolean, false) THEN RAISE EXCEPTION '% grant honoured for another user', act; END IF;
    END LOOP;
  END LOOP;
  -- ...including a grant freshly issued through the RPC.
  gid := (g->0->>'id')::uuid;
  r := resolve_manager_approval(gid, NULL, 'reopen_tab', a);
  IF COALESCE((r->>'ok')::boolean, false) OR r->>'code' <> 'INVALID_APPROVAL' THEN RAISE EXCEPTION 'issued grant honoured: %', r; END IF;

  -- Online manager tickets still work, once, attributed to the manager.
  FOREACH act IN ARRAY ARRAY['reopen_tab', 'process_refund', 'apply_custom_discount'] LOOP
    INSERT INTO manager_approvals (caller_id, action, approver_ids) VALUES (a, act, ARRAY[mgr]) RETURNING id INTO t;
    r := resolve_manager_approval(t, NULL, act, a);
    IF NOT COALESCE((r->>'ok')::boolean, false) OR (r->>'approver_id')::uuid <> mgr THEN RAISE EXCEPTION '% ticket refused: %', act, r; END IF;
    r := resolve_manager_approval(t, NULL, act, a);
    IF COALESCE((r->>'ok')::boolean, false) THEN RAISE EXCEPTION '% ticket reused', act; END IF;
  END LOOP;

  -- Allow-list at issue: only reopen_tab.
  FOREACH act IN ARRAY ARRAY['process_refund', 'edit_paid_tab', 'apply_custom_discount'] LOOP
    INSERT INTO manager_approvals (caller_id, action, approver_ids) VALUES (a, act, ARRAY[mgr]) RETURNING id INTO t;
    BEGIN
      PERFORM issue_offline_approval_grants(t, mgr, act, 1, 60, 'T-1');
      RAISE EXCEPTION '% grant issued', act;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'VALIDATION_ERROR%' THEN RAISE; END IF;
    END;
  END LOOP;

  -- TTL cap (241, 720) and count cap (0, 11).
  FOREACH n IN ARRAY ARRAY[241, 720] LOOP
    INSERT INTO manager_approvals (caller_id, action, approver_ids) VALUES (a, 'reopen_tab', ARRAY[mgr]) RETURNING id INTO t;
    BEGIN
      PERFORM issue_offline_approval_grants(t, mgr, 'reopen_tab', 1, n, 'T-1');
      RAISE EXCEPTION 'TTL % accepted', n;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'VALIDATION_ERROR%' THEN RAISE; END IF;
    END;
  END LOOP;
  FOREACH n IN ARRAY ARRAY[0, 11] LOOP
    INSERT INTO manager_approvals (caller_id, action, approver_ids) VALUES (a, 'reopen_tab', ARRAY[mgr]) RETURNING id INTO t;
    BEGIN
      PERFORM issue_offline_approval_grants(t, mgr, 'reopen_tab', n, 60, 'T-1');
      RAISE EXCEPTION 'count % accepted', n;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'VALIDATION_ERROR%' THEN RAISE; END IF;
    END;
  END LOOP;

  -- report_offline_approvals: only the bound cashier, naming themself as usedBy.
  gid := (g->1->>'id')::uuid;
  PERFORM set_config('request.jwt.claim.sub', b::text, true);
  BEGIN
    PERFORM report_offline_approvals(jsonb_build_array(jsonb_build_object('grantId', gid, 'usedBy', b, 'usedAt', 1700000000000)));
    RAISE EXCEPTION 'another cashier retired the grant';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'AUTH_FORBIDDEN%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', a::text, true);
  BEGIN
    PERFORM report_offline_approvals(jsonb_build_array(jsonb_build_object('grantId', gid, 'usedBy', b, 'usedAt', 1700000000000)));
    RAISE EXCEPTION 'usedBy of another profile accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'AUTH_FORBIDDEN%' THEN RAISE; END IF;
  END;
  IF (SELECT reported_at FROM offline_approval_grants WHERE id = gid) IS NOT NULL THEN RAISE EXCEPTION 'rejected report still retired the grant'; END IF;
  n := report_offline_approvals(jsonb_build_array(jsonb_build_object('grantId', gid, 'usedBy', a, 'usedAt', 1700000000000)));
  IF n <> 1 THEN RAISE EXCEPTION 'bound report not recorded (%)', n; END IF;
  n := report_offline_approvals(jsonb_build_array(jsonb_build_object('grantId', gid, 'usedBy', a, 'usedAt', 1700000000000)));
  IF n <> 0 THEN RAISE EXCEPTION 'report counted twice'; END IF;
  SELECT count(*) INTO n FROM audit_logs WHERE action = 'approval.offline_used' AND entity_id = gid AND after->>'requested_for' = a::text AND after->>'used_by' = a::text;
  IF n <> 1 THEN RAISE EXCEPTION 'report audit row missing'; END IF;
  -- a legacy unbound row is skipped, not an error
  INSERT INTO offline_approval_grants (action, terminal_id, granted_by, expires_at)
    VALUES ('reopen_tab', 'T-1', mgr, now() + interval '1 hour') RETURNING id INTO gid;
  n := report_offline_approvals(jsonb_build_array(jsonb_build_object('grantId', gid, 'usedBy', a, 'usedAt', 1700000000000)));
  IF n <> 0 THEN RAISE EXCEPTION 'legacy row reported'; END IF;

  RAISE NOTICE 'ALL PASS';
END $$;
ROLLBACK;
