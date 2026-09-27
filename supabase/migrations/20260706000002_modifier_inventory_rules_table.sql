-- =============================================================================
-- Phase 17: Modifier -> Inventory Rules
-- Creates modifier_inventory_rules, a join table mapping a modifier to N
-- ingredients, each with a SIGNED delta (D-02): positive = "extra X" (adds
-- usage/depletion), negative = "no X" / "remove X" (reduces usage/depletion).
-- One rule shape covers both directions - no separate mechanism for removal
-- modifiers is needed.
--
-- Structurally identical in shape + RLS to recipe_items
-- (20260428000001_recipes_tables.sql), except the delta is signed (no
-- positive-only CHECK) and the unique key is (modifier_id, ingredient_id)
-- to support N ingredients per modifier (D-03), e.g. "Loaded" -> cheese + bacon.
--
-- Depends on: modifiers table (20260414000003), ingredients table (Phase 03),
-- get_user_role() (existing RBAC helper used by recipe_items/recipes RLS).
-- =============================================================================

-- UP:
BEGIN;

CREATE TABLE modifier_inventory_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modifier_id   uuid NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  delta         numeric NOT NULL CHECK (delta <> 0),  -- signed; zero rows are meaningless
  UNIQUE (modifier_id, ingredient_id)
);

ALTER TABLE modifier_inventory_rules ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read modifier_inventory_rules (bartenders need
-- to see rule info, same as recipe_items)
CREATE POLICY "modifier_inventory_rules_select_authenticated"
  ON modifier_inventory_rules FOR SELECT TO authenticated USING (true);

-- Only manager/admin can write modifier_inventory_rules (defense-in-depth,
-- V4 access control - RLS must not rely solely on the UI-level gate)
CREATE POLICY "modifier_inventory_rules_write_manager"
  ON modifier_inventory_rules FOR ALL TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS modifier_inventory_rules CASCADE;
-- COMMIT;
-- =============================================================================
