-- =============================================================================
-- Phase 19: tip_distribution_entries — immutable per-caja-close tip-bucket snapshot
--
-- One row per caja_session_id, written exactly once (D-04) by the SECURITY
-- DEFINER close_caja_session RPC in the same transaction as the close (D-03).
-- Records the floor/bar/kitchen percentage split in effect at close time plus
-- the resulting largest-remainder amounts (D-02).
--
-- RLS guarantees (mirrors audit_logs, 20260511000001_audit_logs_table.sql):
--   - SELECT: manager + admin only (get_user_role() IN ('manager','admin'))
--   - INSERT/UPDATE/DELETE: forbidden for everyone — append-only by omission.
--     The SECURITY DEFINER close_caja_session RPC is the sole writer and
--     bypasses RLS entirely. Unlike audit_logs, we deliberately do NOT add a
--     redundant "insert authenticated" policy here — the write surface must
--     stay fully closed to clients (Security Domain threat T-19-TAMPER).
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tip_distribution_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caja_session_id uuid NOT NULL UNIQUE REFERENCES caja_sessions(id) ON DELETE CASCADE,
  floor_pct NUMERIC(5,2) NOT NULL,
  bar_pct NUMERIC(5,2) NOT NULL,
  kitchen_pct NUMERIC(5,2) NOT NULL,
  total_tips NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total_tips >= 0),
  floor_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (floor_amount >= 0),
  bar_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (bar_amount >= 0),
  kitchen_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (kitchen_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------
-- 2. Index
-- -----------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tip_distribution_entries_session
  ON tip_distribution_entries(caja_session_id);

-- -----------------------------------------------------------------------
-- 3. RLS — append-only
-- -----------------------------------------------------------------------
ALTER TABLE tip_distribution_entries ENABLE ROW LEVEL SECURITY;

-- SELECT: manager+ only
CREATE POLICY tip_distribution_entries_select_manager
  ON tip_distribution_entries FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- INSERT/UPDATE/DELETE: nobody.
-- (no policies = no access; append-only by omission — the SECURITY DEFINER
--  close_caja_session RPC is the sole writer and bypasses RLS.)

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS tip_distribution_entries;
-- COMMIT;
-- =============================================================================
