-- =============================================================================
-- S3a-02: stock_movements idempotency partial UNIQUE index
--
-- Prevents duplicate depletion movements for the same (ref_type, ref_id, ingredient_id)
-- triple under auto-depletion reasons. Manual adjustment reasons (waste, delivery,
-- correction, physical_count) are intentionally EXCLUDED from this index — they
-- can legitimately be called multiple times for the same ingredient.
--
-- NULL ingredient_id rows are NOT constrained by this index (NULLs are not equal
-- in UNIQUE indexes — product-level movements remain unconstrained, which is correct).
-- =============================================================================

-- UP:
BEGIN;

CREATE UNIQUE INDEX idx_stock_movements_idempotency
  ON stock_movements (ref_type, ref_id, ingredient_id)
  WHERE reason IN ('sale', 'refund', 'void', 'prep_production', 'prep_consumption');

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP INDEX IF EXISTS idx_stock_movements_idempotency;
-- COMMIT;
-- =============================================================================
