-- =============================================================================
-- Phase 14: audit_logs compliance table + record_audit SECURITY DEFINER helper
--
-- audit_logs: append-only table capturing every sensitive domain mutation.
-- record_audit: SECURITY DEFINER fn called by all sensitive RPCs post-mutation.
--
-- RLS guarantees:
--   - INSERT: authenticated users via record_audit (SECURITY DEFINER bypasses RLS)
--   - SELECT: manager + admin only (get_user_role() IN ('manager','admin'))
--   - UPDATE: forbidden for everyone
--   - DELETE: forbidden for everyone
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  action      text        NOT NULL,
  entity_type text        NOT NULL,
  entity_id   uuid        NULL,
  before      jsonb       NULL,
  after       jsonb       NULL,
  terminal_id text        NULL,
  source      text        NOT NULL DEFAULT 'rpc'
                          CHECK (source IN ('rpc','edge','client','trigger')),
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Payload size guard: 64 KB per column
  CONSTRAINT audit_logs_before_size CHECK (pg_column_size(before)  <= 65536),
  CONSTRAINT audit_logs_after_size  CHECK (pg_column_size(after)   <= 65536)
);

-- -----------------------------------------------------------------------
-- 2. Indexes
-- -----------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON audit_logs (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
  ON audit_logs (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON audit_logs (action, created_at DESC);

-- -----------------------------------------------------------------------
-- 3. RLS
-- -----------------------------------------------------------------------
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: manager+ only
CREATE POLICY audit_logs_select_manager
  ON audit_logs FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- INSERT: authenticated users (record_audit is SECURITY DEFINER so this
--         policy is effectively bypassed; included for defense-in-depth)
CREATE POLICY audit_logs_insert_authenticated
  ON audit_logs FOR INSERT TO authenticated
  WITH CHECK (true);

-- UPDATE: nobody
-- DELETE: nobody
-- (no policies = no access; append-only by omission)

-- -----------------------------------------------------------------------
-- 4. record_audit SECURITY DEFINER helper
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid        DEFAULT NULL,
  p_before      jsonb       DEFAULT NULL,
  p_after       jsonb       DEFAULT NULL,
  p_source      text        DEFAULT 'rpc'
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
  -- Capture the calling authenticated user (SECURITY DEFINER preserves JWT)
  v_actor_id := auth.uid();

  -- Truncate oversized payloads (>64KB) with marker
  IF pg_column_size(v_before) > 65536 THEN
    v_before := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;
  IF pg_column_size(v_after) > 65536 THEN
    v_after := jsonb_build_object('_truncated', true, '_reason', 'payload exceeded 64KB');
  END IF;

  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after, source)
  VALUES (v_actor_id, p_action, p_entity_type, p_entity_id, v_before, v_after, p_source)
  RETURNING id INTO v_log_id;

  RETURN v_log_id;

EXCEPTION WHEN OTHERS THEN
  -- Audit failure must NEVER fail the primary action
  -- Log to PostgreSQL server log for DBA visibility
  RAISE WARNING 'record_audit failed: % %', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION record_audit(text, text, uuid, jsonb, jsonb, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION record_audit(text, text, uuid, jsonb, jsonb, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS record_audit(text, text, uuid, jsonb, jsonb, text);
-- DROP TABLE IF EXISTS audit_logs;
-- COMMIT;
-- =============================================================================
