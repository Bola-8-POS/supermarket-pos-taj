-- =============================================================================
-- Phase 27 (27-02): products open-unit linkage columns
--
-- D-04: fully generic — no product-line-specific special-casing. "Openable"
-- is expressed purely as units_per_package IS NOT NULL, "sells via open
-- unit" purely as parent_product_id IS NOT NULL. No product-name/SKU/
-- category special-casing anywhere in this migration or the RPCs that read
-- these columns.
-- =============================================================================

-- UP:
BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS units_per_package int,             -- set on the BOX product (D-02)
  ADD COLUMN IF NOT EXISTS parent_product_id uuid REFERENCES products(id);  -- set on the LOOSE product (D-01)

ALTER TABLE products
  ADD CONSTRAINT units_per_package_positive
  CHECK (units_per_package IS NULL OR units_per_package > 0);

CREATE INDEX IF NOT EXISTS idx_products_parent_product_id
  ON products (parent_product_id);

COMMENT ON COLUMN products.units_per_package IS
  'D-02: fixed loose-piece count per package, configured once on the BOX/parent product. NULL means the product is not openable.';
COMMENT ON COLUMN products.parent_product_id IS
  'D-01: links a loose-piece product to its parent BOX product. NULL means the product does not sell via open units.';

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE products DROP CONSTRAINT IF EXISTS units_per_package_positive;
-- DROP INDEX IF EXISTS idx_products_parent_product_id;
-- ALTER TABLE products DROP COLUMN IF EXISTS parent_product_id;
-- ALTER TABLE products DROP COLUMN IF EXISTS units_per_package;
-- COMMIT;
-- =============================================================================
