\set ON_ERROR_STOP on
-- Static tripwire on function source text: asserts the audit functions build their payloads from an
-- explicit column list (no to_jsonb of a whole row), that record_audit mentions audit_redact and service_role,
-- that record_audit does not initialize its redacted payloads in the declare section, and that one
-- sample call to audit_redact returns the expected payload. Nothing else runs at runtime.
-- Behavioral coverage of actor handling and redaction lives in
-- src/entities/audit-log/model/function-privileges.integration.test.ts.
-- Run as postgres: psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/sql/verify-audit-hardening.sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('set_own_locale', 'force_pin_change')
      AND prosrc ~* 'to_jsonb\s*\(\s*[a-z_]+\s*\)'
  ) THEN
    RAISE EXCEPTION 'an audit payload is built with to_jsonb of a whole row';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'record_audit'
      AND prosrc LIKE '%audit_redact%' AND prosrc LIKE '%service_role%'
  ) THEN
    RAISE EXCEPTION 'record_audit does not redact payloads or restrict the actor';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'record_audit'
      AND prosrc ~ '(v_before|v_after)\s+jsonb\s*:=\s*public\.audit_redact'
  ) THEN
    RAISE EXCEPTION 'record_audit initializes redacted payloads in its declare section';
  END IF;

  IF public.audit_redact('{"pin":"x","keep":1,"n":{"new_pin":"y"},"l":[{"old_pin":"z","ok":true}]}'::jsonb)
     IS DISTINCT FROM '{"keep":1,"n":{},"l":[{"ok":true}]}'::jsonb THEN
    RAISE EXCEPTION 'audit_redact returned an unexpected payload';
  END IF;
END $$;
SELECT 'verify-audit-hardening: ok' AS result;
