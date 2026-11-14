-- =============================================================================
-- S3a-01: ingredients table + CHECK constraints + indexes + RLS
--
-- Adds the ingredient entity. is_prep flag is added here per D4 (locked decision)
-- but is informational only in Phase 3 — the Phase 5 CHECK trigger that enforces
-- is_prep=true → uom='portion' does NOT belong in this migration.
-- =============================================================================

-- UP:
BEGIN;

CREATE TABLE IF NOT EXISTS ingredients (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  uom                     text NOT NULL
    CONSTRAINT ingredients_uom_check CHECK (uom IN ('g','kg','ml','L','unit','portion')),
  purchase_uom            text NULL
    CONSTRAINT ingredients_purchase_uom_check CHECK (
      purchase_uom IS NULL OR purchase_uom IN ('g','kg','ml','L','unit','case_24','portion')
    ),
  purchase_to_base_factor numeric NOT NULL DEFAULT 1
    CONSTRAINT ingredients_factor_positive CHECK (purchase_to_base_factor > 0),
  cost_per_base_unit      numeric(10,4) NOT NULL DEFAULT 0
    CONSTRAINT ingredients_cost_nonneg CHECK (cost_per_base_unit >= 0),
  quantity_on_hand        numeric NOT NULL DEFAULT 0,
  reorder_point           numeric NULL,
  is_prep                 boolean NOT NULL DEFAULT false,
  is_active               boolean NOT NULL DEFAULT true,
  category                text NULL,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_ingredients_name     ON ingredients (name);
CREATE INDEX idx_ingredients_is_active ON ingredients (is_active);
CREATE INDEX idx_ingredients_is_prep   ON ingredients (is_prep);

-- RLS: all authenticated users can read; manager/admin can write
ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_auth_select_ingredients" ON ingredients
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "manager_admin_write_ingredients" ON ingredients
  FOR ALL TO authenticated
  USING  (auth.jwt() ->> 'role' IN ('manager', 'admin'))
  WITH CHECK (auth.jwt() ->> 'role' IN ('manager', 'admin'));

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS ingredients;
-- COMMIT;
-- =============================================================================
