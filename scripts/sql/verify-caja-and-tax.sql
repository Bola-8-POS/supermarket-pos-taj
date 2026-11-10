\set ON_ERROR_STOP on
-- Assertions: caja cash reconciliation, refund attribution, payment tax
-- snapshot, audit payload scrub.
-- Run as postgres: psql -U postgres -v ON_ERROR_STOP=1 < scripts/sql/verify-caja-and-tax.sql
-- Static catalog checks plus a handful of pure-function value checks; every
-- multi-row behavioral scenario lives in the paired integration tests:
-- caja-cash-reconciliation.integration.test.ts, refund-attribution.integration.test.ts,
-- payment-tax-snapshot.integration.test.ts.
DO $$
DECLARE
  v_bad text;
BEGIN
  -- 1. payments.caja_session_id exists, nullable, FK to caja_sessions;
  --    payments.tax_amount / tax_rate_percent / tax_inclusive exist;
  --    constraint payments_tax_rate_range present.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
      AND column_name = 'caja_session_id' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'payments.caja_session_id is missing or not nullable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'public.payments'::regclass AND c.contype = 'f'
      AND c.confrelid = 'public.caja_sessions'::regclass AND a.attname = 'caja_session_id'
  ) THEN
    RAISE EXCEPTION 'payments.caja_session_id has no foreign key to caja_sessions';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
      AND column_name IN ('tax_amount', 'tax_rate_percent', 'tax_inclusive')
  ) <> 3 THEN
    RAISE EXCEPTION 'payments is missing one of tax_amount, tax_rate_percent, tax_inclusive';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_tax_rate_range'
  ) THEN
    RAISE EXCEPTION 'payments_tax_rate_range constraint is missing';
  END IF;

  -- 2. The four helpers exist exactly once each, with search_path pinned on
  --    the SECURITY DEFINER / STABLE ones; anon has no EXECUTE on any of
  --    them; caja_entries.source and caja_sessions.cash_reconciliation exist;
  --    reopen_tab / edit_paid_tab tag their caja_entries rows.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'caja_session_payments') <> 1 THEN
    RAISE EXCEPTION 'caja_session_payments must exist exactly once';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'caja_cash_reconciliation') <> 1 THEN
    RAISE EXCEPTION 'caja_cash_reconciliation must exist exactly once';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'payment_tax_amount') <> 1 THEN
    RAISE EXCEPTION 'payment_tax_amount must exist exactly once';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'billing_tax_settings') <> 1 THEN
    RAISE EXCEPTION 'billing_tax_settings must exist exactly once';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.caja_session_payments(uuid)'::regprocedure
      AND EXISTS (SELECT 1 FROM unnest(proconfig) cfg WHERE cfg LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'caja_session_payments has no pinned search_path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.caja_cash_reconciliation(uuid)'::regprocedure
      AND EXISTS (SELECT 1 FROM unnest(proconfig) cfg WHERE cfg LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'caja_cash_reconciliation has no pinned search_path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.billing_tax_settings()'::regprocedure
      AND prosecdef
      AND EXISTS (SELECT 1 FROM unnest(proconfig) cfg WHERE cfg LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'billing_tax_settings is not SECURITY DEFINER with a pinned search_path';
  END IF;

  IF has_function_privilege('anon', 'public.caja_session_payments(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.caja_cash_reconciliation(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.payment_tax_amount(numeric, numeric, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.billing_tax_settings()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon has EXECUTE on a caja/tax helper';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'caja_entries' AND column_name = 'source'
  ) THEN
    RAISE EXCEPTION 'caja_entries.source is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.caja_entries'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%source%'
  ) THEN
    RAISE EXCEPTION 'caja_entries.source has no CHECK constraint';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'caja_sessions'
      AND column_name = 'cash_reconciliation' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'caja_sessions.cash_reconciliation is missing';
  END IF;

  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.reopen_tab(uuid, integer, text, uuid, uuid)'::regprocedure) NOT LIKE '%''reopen''%' THEN
    RAISE EXCEPTION 'reopen_tab does not tag its caja_entries row source = reopen';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.edit_paid_tab(uuid, integer, jsonb, text, text, uuid, uuid)'::regprocedure) NOT LIKE '%''edit''%' THEN
    RAISE EXCEPTION 'edit_paid_tab does not tag its caja_entries row source = edit';
  END IF;

  -- 3. close_caja_session / get_caja_report read the shared helpers, not the
  --    old duplicated formula or the old per-tab-id predicate.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.close_caja_session(uuid, uuid, numeric, text)'::regprocedure) NOT LIKE '%caja_cash_reconciliation(%' THEN
    RAISE EXCEPTION 'close_caja_session does not call caja_cash_reconciliation';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.close_caja_session(uuid, uuid, numeric, text)'::regprocedure) LIKE '%opening_cash + v_cash_sales%' THEN
    RAISE EXCEPTION 'close_caja_session still has the old duplicated cash formula';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_caja_report(uuid)'::regprocedure) NOT LIKE '%caja_cash_reconciliation(%' THEN
    RAISE EXCEPTION 'get_caja_report does not call caja_cash_reconciliation';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_caja_report(uuid)'::regprocedure) LIKE '%opening_cash + v_cash_sales%' THEN
    RAISE EXCEPTION 'get_caja_report still has the old duplicated cash formula';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_caja_report(uuid)'::regprocedure) NOT LIKE '%caja_session_payments(%' THEN
    RAISE EXCEPTION 'get_caja_report does not read from caja_session_payments';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_caja_report(uuid)'::regprocedure) ~ 'FROM\s+payments[^;]*tab_id\s*=\s*ANY\(v_tab_ids\)' THEN
    RAISE EXCEPTION 'get_caja_report still filters a FROM payments clause by tab_id = ANY(v_tab_ids)';
  END IF;

  -- 4. process_refund: six arguments, sixth named p_caja_session_id; source
  --    contains the CAJA_SESSION_NOT_OPEN check.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'process_refund') <> 1 THEN
    RAISE EXCEPTION 'process_refund must exist exactly once';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'process_refund'
      AND pronargs = 6
      AND (proargnames)[6] = 'p_caja_session_id'
  ) THEN
    RAISE EXCEPTION 'process_refund does not have six arguments with the sixth named p_caja_session_id';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'process_refund') NOT LIKE '%CAJA_SESSION_NOT_OPEN%' THEN
    RAISE EXCEPTION 'process_refund does not check CAJA_SESSION_NOT_OPEN';
  END IF;

  -- 5. process_payment_atomic / process_split_payment_atomic snapshot tax.
  SELECT string_agg(proname, ', ') INTO v_bad
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('process_payment_atomic', 'process_split_payment_atomic')
    AND prosrc NOT LIKE '%payment_tax_amount(%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'missing payment_tax_amount( call in: %', v_bad;
  END IF;

  -- 6. payment_tax_amount matches decomposeTax exactly.
  IF payment_tax_amount(116, 16, true) <> 16.00 THEN
    RAISE EXCEPTION 'payment_tax_amount(116, 16, true) wrong: %', payment_tax_amount(116, 16, true);
  END IF;
  IF payment_tax_amount(100, 16, false) <> 13.79 THEN
    RAISE EXCEPTION 'payment_tax_amount(100, 16, false) wrong: %', payment_tax_amount(100, 16, false);
  END IF;
  IF payment_tax_amount(-116, 16, true) <> -16.00 THEN
    RAISE EXCEPTION 'payment_tax_amount(-116, 16, true) wrong: %', payment_tax_amount(-116, 16, true);
  END IF;
  IF payment_tax_amount(NULL, 16, true) IS NOT NULL THEN
    RAISE EXCEPTION 'payment_tax_amount(NULL, 16, true) must be NULL (STRICT)';
  END IF;
  -- billing_tax_settings() rounds to 2 decimal places so a rate stored with
  -- more precision still matches the payments.tax_rate_percent numeric(5,2)
  -- column a reprint reads back.
  IF scale((SELECT rate_percent FROM billing_tax_settings())) > 2 THEN
    RAISE EXCEPTION 'billing_tax_settings().rate_percent has more than 2 decimal places: %', (SELECT rate_percent FROM billing_tax_settings());
  END IF;

  -- 7. Every audit_logs row is redacted; the scrub recorded itself once;
  --    the insert trigger is present.
  IF (SELECT count(*) FROM audit_logs WHERE before IS DISTINCT FROM audit_redact(before) OR after IS DISTINCT FROM audit_redact(after)) <> 0 THEN
    RAISE EXCEPTION 'audit_logs has a row with an un-redacted pin key';
  END IF;
  IF (SELECT count(*) FROM audit_logs WHERE action = 'audit.redact_keys') < 1 THEN
    RAISE EXCEPTION 'no audit.redact_keys row found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND tgname = 'audit_logs_redact' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'audit_logs_redact trigger is missing';
  END IF;
END $$;
SELECT 'verify-caja-and-tax: ok' AS result;
