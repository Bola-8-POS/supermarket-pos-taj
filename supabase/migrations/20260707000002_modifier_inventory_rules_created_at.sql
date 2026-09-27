-- =============================================================================
-- Phase 17 code review WR-01 fix: modifier_inventory_rules.created_at
--
-- modifier_inventory_rules.id is a random gen_random_uuid() — ordering by it
-- (the WR-01 fix in entities/modifier-inventory-rule/model/queries.ts) is
-- stable across repeated queries but does NOT reflect insertion order, so
-- rows can render in an order the manager did not enter them in. Add a
-- created_at column and order by it instead, matching the intuitive "rows
-- appear in the order they were added" UX.
-- =============================================================================

-- UP:
BEGIN;

ALTER TABLE modifier_inventory_rules
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE modifier_inventory_rules DROP COLUMN created_at;
-- COMMIT;
-- =============================================================================
