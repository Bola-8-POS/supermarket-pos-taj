-- =============================================================================
-- CR-01 gap closure: make stock_movements.product_id nullable
--
-- Phase 3 introduces ingredient-only movements (manual adjustments, waste, etc.)
-- that have no product reference. The original inventory_log schema required
-- product_id NOT NULL (product-only movements). Drop that constraint.
-- =============================================================================

-- UP:
BEGIN;

ALTER TABLE stock_movements
  ALTER COLUMN product_id DROP NOT NULL;

COMMENT ON COLUMN stock_movements.product_id IS
  'FK to products. NULL for ingredient-only movements (Phase 3+).';

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE stock_movements ALTER COLUMN product_id SET NOT NULL;
-- COMMIT;
-- =============================================================================
