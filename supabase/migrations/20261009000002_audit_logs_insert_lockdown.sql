-- two-mode Plan 02c, Task 1 (Ruling 4): audit_logs is closed to client inserts.
--
-- Deliberate changes:
--  (a) drops audit_logs_insert_authenticated (FOR INSERT TO authenticated WITH CHECK (true),
--      20260511000001_audit_logs_table.sql:62-64), which no later migration removed;
--  (b) revokes INSERT/UPDATE/DELETE/TRUNCATE on audit_logs from PUBLIC, anon, authenticated
--      (the SELECT policy and service_role are untouched);
--  (c) record_audit, carried whole from 20260921000002_harden_audit_payloads.sql, gains
--      SET search_path = public, pg_temp and one rule: for a caller that is not the service
--      role it raises a WARNING and returns NULL, inserting nothing, when the action starts
--      with 'offline_sale.' or is 'offline_sale_resolved' with after->>'resolution' other
--      than 'rering' / 'confirmed_after_retry'. Those rows are written only by the
--      resolve_offline_sale RPC (a definer function inserting directly).

DROP POLICY IF EXISTS audit_logs_insert_authenticated ON public.audit_logs;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM PUBLIC, anon, authenticated;

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

    -- Server-only offline-sale rows: a client may not forge them.
    IF left(p_action, 13) = 'offline_sale.'
       OR (p_action = 'offline_sale_resolved'
           AND COALESCE(p_after->>'resolution', '') NOT IN ('rering', 'confirmed_after_retry')) THEN
      RAISE WARNING 'record_audit refused reserved action %', p_action;
      RETURN NULL;
    END IF;
  END IF;

  -- Truncate oversized payloads (>64KB) with marker
  IF pg_column_size(v_before) > 65536 THEN
    v_before := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;
  IF pg_column_size(v_after) > 65536 THEN
    v_after := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
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
