-- =============================================================================
-- Phase 5 (SALE-01 / D-01): Drop 'void_order' role_permissions grant rows
--
-- The void-order feature is being removed end-to-end (client feature folder,
-- edge function, i18n copy). This migration removes the DB-side half of its
-- RBAC grant: the ('manager', 'void_order') and ('admin', 'void_order') rows
-- seeded by supabase/migrations/20260510000001_rls_rewrite_phase13.sql.
--
-- That seeding migration is historical and is NOT edited in place — per this
-- repo's convention, removal is always a new forward migration, never a
-- rewrite of history. This mirrors 20260703000006_role_permissions_view_audit_log.sql's
-- shape in reverse (that one INSERTs with a commented DELETE DOWN block; this
-- one DELETEs with a commented INSERT DOWN block).
-- =============================================================================

-- UP:
BEGIN;

DELETE FROM role_permissions
WHERE role IN ('manager', 'admin') AND action = 'void_order';

COMMIT;

-- =============================================================================
-- DOWN (rollback not applied automatically — documented for reference only):
-- BEGIN;
-- INSERT INTO role_permissions (role, action) VALUES
--   ('manager', 'void_order'),
--   ('admin', 'void_order')
-- ON CONFLICT (role, action) DO NOTHING;
-- COMMIT;
-- =============================================================================
