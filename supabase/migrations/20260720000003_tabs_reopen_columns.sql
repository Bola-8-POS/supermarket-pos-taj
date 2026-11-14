-- =============================================================================
-- Phase 23 Plan 02 — tabs.reopen_count / tabs.last_reopened_at columns
--
-- Track the rolling 24h/2x reopen cap (D-02/D-03): reopen_count is an
-- indexed integer bumped atomically inside reopen_tab under the SAME
-- FOR UPDATE row lock already taken for the p_expected_version check (never
-- derived from an audit_logs COUNT — see 23-RESEARCH.md Anti-Patterns).
-- last_reopened_at records the timestamp of the MOST RECENT reopen; the 24h
-- window resets on each reopen per D-02, so this is read+compared under the
-- same lock, not the original tab-close time.
--
-- Deliberately does NOT add any CHECK here — the existing
-- closed_at_requires_closed_status constraint (20260427000001) already
-- governs the status/closed_at relationship these columns ride alongside;
-- adding a second overlapping CHECK on this migration would risk conflicting
-- with it for no benefit (reopen_count/last_reopened_at have no status
-- dependency of their own).
-- =============================================================================

-- UP:
BEGIN;

ALTER TABLE tabs
  ADD COLUMN IF NOT EXISTS reopen_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reopened_at timestamptz;

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback — Phase 8 standard):
-- BEGIN;
-- ALTER TABLE tabs DROP COLUMN IF EXISTS reopen_count;
-- ALTER TABLE tabs DROP COLUMN IF EXISTS last_reopened_at;
-- COMMIT;
-- =============================================================================
