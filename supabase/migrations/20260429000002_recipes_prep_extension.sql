-- Migration: extend recipes table to support prep-ingredient-owned recipes
-- Idempotent: all DDL uses IF EXISTS / IF NOT EXISTS guards

BEGIN;

-- 1. Make product_id nullable (currently NOT NULL)
ALTER TABLE recipes
  ALTER COLUMN product_id DROP NOT NULL;

-- 2. Add prep_ingredient_id FK (nullable; prep-owned recipes use this)
ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS prep_ingredient_id uuid REFERENCES ingredients(id) ON DELETE CASCADE;

-- 3. Drop the implicit UNIQUE constraint on product_id from column-level UNIQUE
--    PostgreSQL auto-names this "recipes_product_id_key"
ALTER TABLE recipes
  DROP CONSTRAINT IF EXISTS recipes_product_id_key;

-- 4. Partial unique indexes (NULL-safe; one unique value per non-null set)
CREATE UNIQUE INDEX IF NOT EXISTS recipes_product_id_unique
  ON recipes (product_id)
  WHERE product_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS recipes_prep_ingredient_id_unique
  ON recipes (prep_ingredient_id)
  WHERE prep_ingredient_id IS NOT NULL;

-- 5. Exactly-one owner CHECK constraint
--    Each recipe row must be owned by either a product OR a prep ingredient, never both, never neither
--    Note: `ADD CONSTRAINT IF NOT EXISTS` is not valid PostgreSQL syntax (only
--    `DROP CONSTRAINT IF EXISTS` is) — guard idempotency by name lookup instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recipes_exactly_one_owner'
  ) THEN
    ALTER TABLE recipes
      ADD CONSTRAINT recipes_exactly_one_owner
      CHECK (
        (product_id IS NOT NULL AND prep_ingredient_id IS NULL)
        OR
        (product_id IS NULL AND prep_ingredient_id IS NOT NULL)
      );
  END IF;
END $$;

COMMIT;
