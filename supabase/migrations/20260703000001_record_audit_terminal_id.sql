-- =============================================================================
-- Phase 14-02: Add p_terminal_id + p_user_id to record_audit()
--
-- record_audit() currently accepts 6 params (p_action, p_entity_type,
-- p_entity_id, p_before, p_after, p_source) and always derives the actor from
-- auth.uid(). Two problems:
--
--   1. Terminal ID is never captured for RPC-sourced audit rows, leaving
--      audit_logs.terminal_id permanently NULL for every RPC call site
--      (Pitfall 3).
--   2. `src/app/OfflineQueueProcessor.tsx` already calls
--      supabase.rpc('record_audit', { ..., p_terminal_id: TERMINAL_ID,
--      p_user_id: null }) — params that do not exist in the deployed
--      signature. Supabase/PostgREST silently drops unknown named params, so
--      this call has been resolving against record_audit/6 with no error but
--      also with no terminal_id ever recorded.
--
-- Because a `CREATE OR REPLACE FUNCTION` with additional parameters creates a
-- NEW overload (record_audit/8) while record_audit/6 remains registered, the
-- 6-positional PERFORM record_audit(...) calls already wired into
-- process_payment_atomic / process_refund / close_caja_session /
-- add_combo_to_tab would become ambiguous (two functions both satisfy 6 args
-- once the trailing 2 have defaults). We therefore DROP the /6 overload
-- first, then CREATE the single /8 overload with the 2 new trailing
-- DEFAULT NULL params. This keeps the 6-arg PERFORM calls valid (they resolve
-- against /8 with p_terminal_id/p_user_id defaulting to NULL) while unlocking
-- the OfflineQueueProcessor's terminal_id/user_id keys.
--
-- Behavioral changes only:
--   1. v_actor_id := COALESCE(p_user_id, auth.uid())  — allows trusted
--      server-side callers (e.g. offline-queue replay) to attribute a
--      specific actor when auth.uid() is not meaningful for the call.
--   2. terminal_id is now inserted into audit_logs (column already exists,
--      added by 20260511000001_audit_logs_table.sql, previously never
--      populated).
--
-- All other original semantics (64KB truncation, SECURITY DEFINER,
-- SET search_path = public, EXCEPTION WHEN OTHERS -> RAISE WARNING + RETURN
-- NULL) are preserved verbatim.
-- =============================================================================

-- UP:
BEGIN;

DROP FUNCTION IF EXISTS record_audit(text, text, uuid, jsonb, jsonb, text);

CREATE FUNCTION record_audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid        DEFAULT NULL,
  p_before      jsonb       DEFAULT NULL,
  p_after       jsonb       DEFAULT NULL,
  p_source      text        DEFAULT 'rpc',
  p_terminal_id text        DEFAULT NULL,
  p_user_id     uuid        DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id   uuid;
  v_before     jsonb := p_before;
  v_after      jsonb := p_after;
  v_log_id     uuid;
BEGIN
  -- Capture the calling authenticated user (SECURITY DEFINER preserves JWT),
  -- unless the caller explicitly supplies p_user_id (trusted server paths
  -- such as OfflineQueueProcessor's discard-audit, where auth.uid() may not
  -- reflect the original actor of the replayed action).
  v_actor_id := COALESCE(p_user_id, auth.uid());

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
$$;

GRANT EXECUTE ON FUNCTION record_audit(text, text, uuid, jsonb, jsonb, text, text, uuid) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION record_audit(text, text, uuid, jsonb, jsonb, text, text, uuid) FROM authenticated;
-- DROP FUNCTION IF EXISTS record_audit(text, text, uuid, jsonb, jsonb, text, text, uuid);
-- CREATE FUNCTION record_audit(
--   p_action      text,
--   p_entity_type text,
--   p_entity_id   uuid        DEFAULT NULL,
--   p_before      jsonb       DEFAULT NULL,
--   p_after       jsonb       DEFAULT NULL,
--   p_source      text        DEFAULT 'rpc'
-- )
-- RETURNS uuid
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $$
-- DECLARE
--   v_actor_id   uuid;
--   v_before     jsonb := p_before;
--   v_after      jsonb := p_after;
--   v_log_id     uuid;
-- BEGIN
--   v_actor_id := auth.uid();
--   IF pg_column_size(v_before) > 65536 THEN
--     v_before := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
--   END IF;
--   IF pg_column_size(v_after) > 65536 THEN
--     v_after := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
--   END IF;
--   INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after, source)
--   VALUES (v_actor_id, p_action, p_entity_type, p_entity_id, v_before, v_after, p_source)
--   RETURNING id INTO v_log_id;
--   RETURN v_log_id;
-- EXCEPTION WHEN OTHERS THEN
--   RAISE WARNING 'record_audit failed: % %', SQLERRM, SQLSTATE;
--   RETURN NULL;
-- END;
-- $$;
-- GRANT EXECUTE ON FUNCTION record_audit(text, text, uuid, jsonb, jsonb, text) TO authenticated;
-- COMMIT;
-- =============================================================================
