-- two-mode Plan 02c final fix A1 (Security I-1): record_audit refuses lookalikes of the
-- server's offline-sale actions.
--
-- Deliberate changes, record_audit carried whole from 20261009000002_audit_logs_insert_lockdown.sql:
--  (a) for a non-service caller p_action must match ^[a-z0-9_.]+$ (a leading/trailing space or a
--      capital no longer slips past the exact-prefix check and reads as a server row in /audit);
--  (b) any action that reduces (letters only) to 'offlinesale...' is refused unless it is exactly
--      offline_sale_needs_review, or offline_sale_resolved with resolution rering /
--      confirmed_after_retry (the three rows the client still writes);
--  (c) rule (b) reads the payload AFTER the 64 KB truncation, so padding cannot smuggle an
--      allowed resolution. Refusal is unchanged: WARNING + NULL, nothing inserted.

CREATE OR REPLACE FUNCTION public.record_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid DEFAULT NULL::uuid,
  p_before jsonb DEFAULT NULL::jsonb,
  p_after jsonb DEFAULT NULL::jsonb,
  p_source text DEFAULT 'rpc'::text,
  p_terminal_id text DEFAULT NULL::text,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor_id   uuid;
  v_before     jsonb;
  v_after      jsonb;
  v_log_id     uuid;
BEGIN
  v_before := public.audit_redact(p_before);
  v_after := public.audit_redact(p_after);

  -- Only the service role may name the actor (trusted server paths); every
  -- other caller is recorded as the authenticated user.
  -- A plain database session without JWT claims (auth.role() NULL) gets a NULL actor.
  IF auth.role() = 'service_role' THEN
    v_actor_id := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor_id := auth.uid();

  END IF;

  -- Truncate oversized payloads (>64KB) with marker
  IF pg_column_size(v_before) > 65536 THEN
    v_before := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;
  IF pg_column_size(v_after) > 65536 THEN
    v_after := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;

  -- Non-service callers: action names are lower-case [a-z0-9_.] only, and the
  -- server's offline-sale namespace (any spelling that reads as it) is reserved,
  -- except the three rows the client still writes. Evaluated on the stored
  -- (post-truncation) payload so padding cannot carry an allowed resolution.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF p_action !~ '^[a-z0-9_.]+$'
       OR (regexp_replace(p_action, '[^a-z]', '', 'g') LIKE 'offlinesale%'
           AND NOT (p_action = 'offline_sale_needs_review'
                    OR (p_action = 'offline_sale_resolved'
                        AND COALESCE(v_after->>'resolution', '') IN ('rering', 'confirmed_after_retry')))) THEN
      RAISE WARNING 'record_audit refused reserved or malformed action %', p_action;
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after, source, terminal_id)
  VALUES (v_actor_id, p_action, p_entity_type, p_entity_id, v_before, v_after, p_source, p_terminal_id)
  RETURNING id INTO v_log_id;

  RETURN v_log_id;

EXCEPTION WHEN OTHERS THEN
  -- Audit failure must NEVER fail the primary action
  -- Log to PostgreSQL server log for DBA visibility
  RAISE WARNING 'record_audit failed: % %', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$function$;

NOTIFY pgrst, 'reload schema';
