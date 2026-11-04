-- =============================================================================
-- Phase 1 (strip-rebrand), Plan 07 Task 2: DROP Kitchen Display System (KDS)
-- and batch chef prep production objects.
--
-- Neither KDS boards nor batch prep production apply to a grocery store
-- (Phase Boundary, PROJECT.md Out of Scope). All application code (entities,
-- features, widgets, pages) was already deleted in this plan's Task 1.
--
-- Scope correction vs. the migration filename `caja_open_prep_batch_rpcs.sql`:
-- that migration created TWO RPCs, `caja_open` and `produce_prep_batch`.
-- Only `produce_prep_batch` is prep-domain. `caja_open` is core retained
-- caja-session-open functionality (src/entities/caja/model/queries.ts still
-- calls it) and MUST NOT be dropped — dropping it would break every register
-- open. This migration drops `produce_prep_batch` only.
--
-- `kds_enabled` is not its own `settings` row — it is a nested key inside the
-- 'receipt' row's JSONB `value` blob (see 20260422000006_kds_enabled_setting.sql,
-- `value = value || '{"kds_enabled": false}'::jsonb WHERE key = 'receipt'`).
-- Removed here via jsonb `-` key-delete, not a row DELETE.
--
-- `recipes.prep_ingredient_id` (added by 20260429000002_recipes_prep_extension.sql)
-- is deliberately NOT touched here — it extends the shared `recipes` table
-- owned by Plan 01-09 (combos/recipes strip). Left for 01-09 to resolve
-- against its own scope (see that migration's header note).
--
-- The `kitchen` StaffRole, its RLS policies (order_items/orders/tabs/
-- products/categories/stock_movements/shifts SELECT/UPDATE for
-- get_user_role() = 'kitchen'), and role_permissions rows for
-- 'produce_prep_batch'/'view_kds'/'view_kds_bar' are also deliberately NOT
-- touched — the kitchen role remains a valid StaffRole regardless of KDS
-- removal (see this plan's threat_model). Cleaning those up is an RBAC/RLS
-- audit out of this plan's scope.
--
-- Irreversible for any already-written prep_productions data; DOWN section
-- recreates schema only (D-19), does not restore data.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- 1. produce_prep_batch RPC (prep-only half of 20260703000003's two RPCs)
-- -----------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.produce_prep_batch(uuid, numeric, text, uuid, text) CASCADE;

-- -----------------------------------------------------------------------
-- 2. prep_productions table, its trigger, and the trigger function
-- -----------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_prep_production_insert ON prep_productions;
DROP FUNCTION IF EXISTS public.fn_prep_production_insert() CASCADE;
DROP TABLE IF EXISTS prep_productions CASCADE;

-- -----------------------------------------------------------------------
-- 3. kds_enabled key inside the 'receipt' settings row's JSONB value
-- -----------------------------------------------------------------------
UPDATE settings
SET value = value - 'kds_enabled'
WHERE key = 'receipt';

-- -----------------------------------------------------------------------
-- 4. KDS-core: kds_status column on order_items (drops its partial index
--    automatically), then the now-unused kds_status enum type
-- -----------------------------------------------------------------------
ALTER TABLE order_items DROP COLUMN IF EXISTS kds_status;
DROP TYPE IF EXISTS kds_status;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- DOWN:
-- BEGIN;
-- CREATE TYPE kds_status AS ENUM ('pending', 'in_progress', 'done');
-- ALTER TABLE order_items
--   ADD COLUMN kds_status kds_status NOT NULL DEFAULT 'pending';
-- CREATE INDEX idx_order_items_kds_status
--   ON order_items(kds_status)
--   WHERE kds_status <> 'done';
--
-- UPDATE settings
-- SET value = value || '{"kds_enabled": false}'::jsonb
-- WHERE key = 'receipt';
--
-- CREATE TABLE prep_productions (
--   id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   prep_ingredient_id  uuid NOT NULL REFERENCES ingredients(id),
--   qty_produced        numeric NOT NULL CHECK (qty_produced > 0),
--   notes               text,
--   produced_by         uuid REFERENCES profiles(id),
--   created_at          timestamptz NOT NULL DEFAULT now()
-- );
-- -- Recreate RLS, indexes, trigger function/trigger, and the
-- -- produce_prep_batch RPC from 20260429000001/20260429000003/
-- -- 20260703000003 if fully reverting (schema shape only — no data).
-- COMMIT;
-- =============================================================================
