-- =============================================================================
-- Phase 16: Kitchen/Bar Split Routing
--
-- Replace categories.is_food boolean with categories.routing enum (D-01/D-03).
-- Single source of truth for routing — is_food/routing can never disagree.
--
-- Backfill (D-03, bar-first default): is_food=true -> KITCHEN, is_food=false -> BAR.
-- 'NONE' is not auto-assigned; admins flip individual categories to NONE
-- manually post-migration (e.g. merch, non-prepped items).
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. Enum type (guarded — CREATE TYPE has no IF NOT EXISTS)
-- -----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'category_routing') THEN
    CREATE TYPE category_routing AS ENUM ('KITCHEN', 'BAR', 'NONE');
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 2. Add routing column
-- -----------------------------------------------------------------------
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS routing category_routing NOT NULL DEFAULT 'NONE';

-- -----------------------------------------------------------------------
-- 3. Backfill from is_food (T-16-01: must happen before the DROP, same txn)
-- -----------------------------------------------------------------------
UPDATE categories SET routing = CASE WHEN is_food THEN 'KITCHEN' ELSE 'BAR' END::category_routing;

-- -----------------------------------------------------------------------
-- 4. Drop the old column
-- -----------------------------------------------------------------------
ALTER TABLE categories DROP COLUMN IF EXISTS is_food;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_food boolean NOT NULL DEFAULT false;
-- UPDATE categories SET is_food = (routing = 'KITCHEN');
-- ALTER TABLE categories DROP COLUMN IF EXISTS routing;
-- DROP TYPE IF EXISTS category_routing;
-- COMMIT;
-- =============================================================================
