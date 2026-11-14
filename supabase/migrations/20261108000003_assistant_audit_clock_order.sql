-- Phase 29 (Plan 29-03) follow-up to 20261108000002 (L13: a fix goes in a new file).
--
-- assistant_audit inserted audit_logs rows with the column default now(), the TRANSACTION start time. One
-- assistant_approve call writes assistant.approved and then assistant.executed (or assistant.failed) in one
-- transaction, so both rows carried the same created_at and their order in the audit trail (and in any
-- ORDER BY created_at read) was arbitrary. clock_timestamp() gives each row its real insert time, so the
-- lifecycle reads staged -> approved -> executed/failed. Nothing else changes; grants are preserved by
-- CREATE OR REPLACE (still no EXECUTE for clients).
CREATE OR REPLACE FUNCTION public.assistant_audit(p_action text, p_entity_id uuid, p_after jsonb, p_terminal text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after, source, terminal_id, created_at)
  VALUES (
    auth.uid(), p_action, 'assistant_proposal', p_entity_id, NULL,
    public.audit_redact(COALESCE(p_after, '{}'::jsonb) || jsonb_build_object('origin', 'local_assistant')),
    'rpc', p_terminal, clock_timestamp()
  );
END;
$$;
