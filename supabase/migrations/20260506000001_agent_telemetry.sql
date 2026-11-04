-- Sprint A: Telemetry Foundation
-- Creates pos_error_log and agent_audit_log tables for AI agent diagnostics

CREATE TABLE IF NOT EXISTS pos_error_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  error_code   text        NOT NULL,
  message      text        NOT NULL,
  detail       text,
  component    text,
  user_id      uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  session_id   text,
  raw          jsonb
);

CREATE TABLE IF NOT EXISTS agent_audit_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  tool_name    text        NOT NULL,
  args         jsonb,
  result       jsonb,
  user_id      uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  user_role    text,
  duration_ms  integer
);

ALTER TABLE pos_error_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_log  ENABLE ROW LEVEL SECURITY;

-- Authenticated users can insert their own errors
CREATE POLICY "authenticated_insert" ON pos_error_log
  FOR INSERT TO authenticated WITH CHECK (true);

-- Managers+ can read all errors
CREATE POLICY "manager_select" ON pos_error_log
  FOR SELECT TO authenticated USING (true);

-- Authenticated users can insert audit entries
CREATE POLICY "authenticated_insert" ON agent_audit_log
  FOR INSERT TO authenticated WITH CHECK (true);

-- Managers+ can read audit log
CREATE POLICY "manager_select" ON agent_audit_log
  FOR SELECT TO authenticated USING (true);

-- Indexes for time-range queries used by diagnostic report
CREATE INDEX ON pos_error_log   (created_at DESC);
CREATE INDEX ON agent_audit_log (created_at DESC);
CREATE INDEX ON pos_error_log   (error_code);
