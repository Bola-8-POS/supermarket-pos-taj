-- =============================================================================
-- Phase 4: Recipes & Sale Depletion
-- Creates recipes, recipe_items, and audit_log tables.
--
-- IMPORTANT: audit_log column names match add_combo_to_tab's existing INSERT shape:
--   action, entity_type, entity_id, details (+ actor_id added as nullable)
-- Once audit_log exists, add_combo_to_tab's EXCEPTION WHEN undefined_table guard
--   auto-activates and starts writing rows — this is expected behavior.
--
-- Depends on: ingredients table (Phase 03), products table, profiles table
-- =============================================================================

-- UP:
BEGIN;

-- ============================================================
-- 1. recipes
-- ============================================================
CREATE TABLE recipes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  yield_qty   numeric NOT NULL DEFAULT 1 CHECK (yield_qty > 0),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read recipes (bartenders need to see recipe info)
CREATE POLICY "recipes_select_authenticated"
  ON recipes FOR SELECT TO authenticated USING (true);

-- Only manager/admin can write recipes (T-04-01 mitigation)
CREATE POLICY "recipes_write_manager"
  ON recipes FOR ALL TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- ============================================================
-- 2. recipe_items
-- ============================================================
CREATE TABLE recipe_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id     uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  qty           numeric NOT NULL CHECK (qty > 0),  -- T-04-02: positive qty enforced at DB level
  UNIQUE (recipe_id, ingredient_id)
);

ALTER TABLE recipe_items ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read recipe_items
CREATE POLICY "recipe_items_select_authenticated"
  ON recipe_items FOR SELECT TO authenticated USING (true);

-- Only manager/admin can write recipe_items (T-04-01 mitigation)
CREATE POLICY "recipe_items_write_manager"
  ON recipe_items FOR ALL TO authenticated
  USING (get_user_role() IN ('manager', 'admin'))
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- ============================================================
-- 3. audit_log
-- Column names canonical from add_combo_to_tab INSERT:
--   action, entity_type, entity_id, details, created_at
-- actor_id added as nullable (populated by override flow; not in original INSERT).
-- T-04-04: SECURITY DEFINER functions insert here; client cannot bypass.
-- ============================================================
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action      text NOT NULL,
  actor_id    uuid REFERENCES profiles(id),   -- nullable: populated by override flows
  entity_type text,    -- e.g. 'product', 'order_item', 'tab'
  entity_id   uuid,    -- entity being acted on
  details     jsonb,   -- arbitrary context payload
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Authenticated users (and SECURITY DEFINER functions acting as them) can insert
CREATE POLICY "audit_log_insert_authenticated"
  ON audit_log FOR INSERT TO authenticated WITH CHECK (true);

-- Only manager/admin can read audit log
CREATE POLICY "audit_log_select_manager"
  ON audit_log FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- ============================================================
-- 4. updated_at trigger for recipes
-- ============================================================
CREATE OR REPLACE FUNCTION update_recipes_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER recipes_updated_at
  BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION update_recipes_updated_at();

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TRIGGER IF EXISTS recipes_updated_at ON recipes;
-- DROP FUNCTION IF EXISTS update_recipes_updated_at();
-- DROP TABLE IF EXISTS audit_log;
-- DROP TABLE IF EXISTS recipe_items;
-- DROP TABLE IF EXISTS recipes;
-- COMMIT;
-- =============================================================================
