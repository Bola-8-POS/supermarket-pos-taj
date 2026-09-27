-- =============================================================================
-- S1-04: Add combo flags to products
-- =============================================================================

BEGIN;

-- combo_eligible: this product can be included as a component in a combo.
-- is_combo: this product IS a combo (composed of other products).
ALTER TABLE products
  ADD COLUMN combo_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN is_combo        boolean NOT NULL DEFAULT false;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE products
--   DROP COLUMN IF EXISTS is_combo,
--   DROP COLUMN IF EXISTS combo_eligible;
-- COMMIT;
-- =============================================================================
