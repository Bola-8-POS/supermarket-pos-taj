-- =============================================================================
-- Phase 14-10: Seed 'view_audit_log' into role_permissions (manager + admin)
--
-- Adds client-side rbac.ts parity for the new /audit page permission. The
-- frontend already grants 'view_audit_log' to manager (and admin, which
-- inherits all manager actions) via STAFF_ACTIONS + MANAGER_EXTRA. This
-- migration keeps the DB-level role_permissions table (Phase 13) in sync so
-- any future server-side permission check against role_permissions matches
-- the frontend's RBAC matrix exactly.
--
-- Uses the same (role, action) UNIQUE constraint / ON CONFLICT target as the
-- Phase 13 seed (20260510000001_rls_rewrite_phase13.sql, BLOCK 3).
-- =============================================================================

-- UP:
BEGIN;

INSERT INTO role_permissions (role, action) VALUES
  ('manager', 'view_audit_log'),
  ('admin', 'view_audit_log')
ON CONFLICT (role, action) DO NOTHING;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DELETE FROM role_permissions WHERE role IN ('manager', 'admin') AND action = 'view_audit_log';
-- COMMIT;
-- =============================================================================
