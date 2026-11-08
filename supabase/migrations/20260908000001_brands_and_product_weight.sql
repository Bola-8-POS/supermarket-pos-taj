-- =============================================================================
-- Phase 32 (32-01): brands table + products.brand_id/weight_amount/weight_unit
--
-- D-01: brand is name-only (no logo/sortOrder/description).
-- D-02: products.brand_id uses ON DELETE RESTRICT (same as category_id),
--       even though brand_id is nullable — deleting a brand is blocked while
--       any product still references it.
-- D-03: brand name has a DB-level case-insensitive unique constraint.
-- D-06/D-07: weight_amount/weight_unit are both-or-neither, weight_amount is
--       a positive number with at most 2 decimal places (mirrors the existing
--       happy_hour_valid both-or-neither CHECK on categories).
-- =============================================================================

-- UP:
BEGIN;

CREATE TABLE IF NOT EXISTS brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS brands_lower_name_key ON brands (lower(name));

ALTER TABLE brands ENABLE ROW LEVEL SECURITY;

CREATE POLICY "brands_select_authenticated" ON brands
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "anon_read_brands" ON public.brands
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "brands_insert_manager_admin" ON brands
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "brands_update_manager_admin" ON brands
  FOR UPDATE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

CREATE POLICY "brands_delete_manager_admin" ON brands
  FOR DELETE TO authenticated
  USING (EXISTS(SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brands(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS weight_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS weight_unit text;

ALTER TABLE products
  ADD CONSTRAINT weight_amount_positive CHECK (weight_amount IS NULL OR weight_amount > 0),
  ADD CONSTRAINT weight_unit_valid CHECK (weight_unit IS NULL OR weight_unit IN ('g','kg','lb','oz')),
  ADD CONSTRAINT weight_both_or_neither CHECK (
    (weight_amount IS NULL AND weight_unit IS NULL) OR
    (weight_amount IS NOT NULL AND weight_unit IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products (brand_id);

COMMENT ON TABLE brands IS 'Phase 32 D-01: flat, name-only brand entity — no hierarchy/logo/sortOrder.';
COMMENT ON COLUMN products.brand_id IS 'Phase 32 D-02: nullable FK, ON DELETE RESTRICT — deleting a referenced brand is blocked, never silently nulled.';
COMMENT ON COLUMN products.weight_amount IS 'Phase 32 D-06/D-07: catalog pack-size display attribute (e.g. "500" for "500 g"), independent of the loose-weight-at-checkout system. Both-or-neither with weight_unit.';
COMMENT ON COLUMN products.weight_unit IS 'Phase 32 D-06: catalog pack-size unit (g/kg/lb/oz). Both-or-neither with weight_amount.';

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE products DROP CONSTRAINT IF EXISTS weight_both_or_neither;
-- ALTER TABLE products DROP CONSTRAINT IF EXISTS weight_unit_valid;
-- ALTER TABLE products DROP CONSTRAINT IF EXISTS weight_amount_positive;
-- DROP INDEX IF EXISTS idx_products_brand_id;
-- ALTER TABLE products DROP COLUMN IF EXISTS weight_unit;
-- ALTER TABLE products DROP COLUMN IF EXISTS weight_amount;
-- ALTER TABLE products DROP COLUMN IF EXISTS brand_id;
-- DROP TABLE IF EXISTS brands;
-- COMMIT;
-- =============================================================================
