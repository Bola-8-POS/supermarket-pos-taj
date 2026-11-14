-- =============================================================================
-- Phase 20 (promotions-engine), Plan 06 Task 1: D-07 additive HH -> promotions
-- data migration.
--
-- Converts every product with a happy_hour_price whose category has an HH
-- window (happy_hour_start/happy_hour_end both set) into an equivalent
-- fixed_price promotion + promotion_availability row. This reproduces
-- resolveProductPrice()'s legacy semantics (src/shared/lib/domain-helpers.ts):
-- the HH price applies when the category's window is active AND the
-- product's happy_hour_price is not null. A fixed_price promotion whose
-- availability window matches the same category window yields the identical
-- charged price during that window (evaluate_promotions_for_item's fixed_price
-- branch resets the running price to discount_value, exactly the legacy
-- override behavior).
--
-- ADDITIVE ONLY (Pitfall 4) — this migration does NOT touch happy_hour_start,
-- happy_hour_end, or happy_hour_price. The column drop is a separate,
-- later-wave migration (Plan 20-10) gated behind a verification checkpoint.
--
-- Idempotent: a NOT EXISTS guard prevents duplicate promotion rows if this
-- migration is re-run.
-- =============================================================================

-- UP: insert fixed_price promotions + availability windows from legacy HH data
BEGIN;

WITH source AS (
  SELECT
    p.id            AS product_id,
    p.name          AS product_name,
    p.happy_hour_price AS happy_hour_price,
    c.happy_hour_start AS happy_hour_start,
    c.happy_hour_end   AS happy_hour_end
  FROM products p
  JOIN categories c ON c.id = p.category_id
  WHERE p.happy_hour_price IS NOT NULL
    AND c.happy_hour_start IS NOT NULL
    AND c.happy_hour_end IS NOT NULL
),
inserted_promotions AS (
  INSERT INTO promotions (
    name,
    discount_type,
    discount_value,
    target_type,
    target_product_id,
    priority,
    is_active
  )
  SELECT
    'Happy Hour: ' || s.product_name,
    'fixed_price',
    s.happy_hour_price,
    'item',
    s.product_id,
    0,
    true
  FROM source s
  WHERE NOT EXISTS (
    SELECT 1 FROM promotions x
    WHERE x.target_product_id = s.product_id
      AND x.discount_type = 'fixed_price'
      AND x.name LIKE 'Happy Hour:%'
  )
  RETURNING id, target_product_id
)
INSERT INTO promotion_availability (
  promotion_id,
  days_of_week,
  start_time,
  end_time
)
SELECT
  ip.id,
  '{1,2,3,4,5,6,7}',
  s.happy_hour_start,
  s.happy_hour_end
FROM inserted_promotions ip
JOIN source s ON s.product_id = ip.target_product_id;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DELETE FROM promotions WHERE discount_type = 'fixed_price' AND name LIKE 'Happy Hour:%';
-- COMMIT;
-- =============================================================================
