-- =============================================================================
-- Phase 4: deplete_for_order_item v2 — adds p_allow_negative override param
--
-- Extends deplete_for_order_item with:
--   p_allow_negative boolean DEFAULT false — when true, INVENTORY_NEGATIVE errors
--     are caught and stock is bypassed by directly updating ingredients.quantity_on_hand.
--     An audit_log row is inserted in SECURITY DEFINER context for repudiation defense
--     (T-04-07 mitigation). Any other error is re-raised as normal.
--
-- Both function signatures coexist as Postgres overloads:
--   deplete_for_order_item(uuid, smallint)          — v1 (migration 002)
--   deplete_for_order_item(uuid, smallint, boolean) — v2 (this migration)
--
-- Depends on:
--   - 20260428000001_recipes_tables.sql (recipes, recipe_items, audit_log tables)
--   - 20260428000002_deplete_for_order_item.sql (v1 base; v2 adds new overload)
--   - 20260426000003_record_stock_movement_rpc.sql (record_stock_movement signature)
-- =============================================================================

-- UP:
CREATE OR REPLACE FUNCTION deplete_for_order_item(
  p_order_item_id  uuid,
  p_direction      smallint,  -- +1 sale (subtract), -1 refund/void (add back)
  p_allow_negative boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id  uuid;
  v_qty         int;
  v_recipe_id   uuid;
  v_yield_qty   numeric;
  v_item        record;
  v_delta       numeric;
  v_reason      text;
BEGIN
  -- 1. Resolve order_item → product_id + quantity
  SELECT product_id, quantity
    INTO v_product_id, v_qty
    FROM order_items
   WHERE id = p_order_item_id;

  IF NOT FOUND THEN RETURN; END IF;

  -- 2. Find recipe for product; no recipe → return early (beer, water, etc.)
  SELECT id, yield_qty
    INTO v_recipe_id, v_yield_qty
    FROM recipes
   WHERE product_id = v_product_id;

  IF NOT FOUND THEN RETURN; END IF;

  v_reason := CASE WHEN p_direction = 1 THEN 'sale' ELSE 'refund' END;

  -- 3. Deplete each ingredient in the recipe
  FOR v_item IN
    SELECT ingredient_id, qty
      FROM recipe_items
     WHERE recipe_id = v_recipe_id
  LOOP
    -- delta = -(direction × order_qty × ingredient_qty / yield_qty)
    -- +1 direction (sale)   → negative delta (subtract from stock)
    -- -1 direction (refund) → positive delta (add back to stock)
    v_delta := -p_direction::numeric
               * v_qty::numeric
               * v_item.qty
               / v_yield_qty;

    BEGIN
      PERFORM record_stock_movement(
        v_item.ingredient_id,
        v_delta,
        v_reason,         -- 'sale' or 'refund'
        'order_item',     -- ref_type
        p_order_item_id,  -- ref_id (idempotency key — UNIQUE with ingredient_id)
        NULL              -- notes
      );
    EXCEPTION WHEN OTHERS THEN
      -- Only bypass INVENTORY_NEGATIVE when override is explicitly allowed
      IF p_allow_negative AND SQLERRM LIKE '%INVENTORY_NEGATIVE%' THEN
        -- Bypass: directly update stock (record_stock_movement blocked it)
        UPDATE ingredients
           SET quantity_on_hand = quantity_on_hand + v_delta
         WHERE id = v_item.ingredient_id;

        -- Write audit trail (SECURITY DEFINER context — cannot be bypassed by client)
        INSERT INTO audit_log (action, entity_type, entity_id, details, created_at)
        VALUES (
          'stock_override',
          'order_item',
          p_order_item_id,
          jsonb_build_object(
            'ingredient_id', v_item.ingredient_id,
            'delta', v_delta,
            'reason', 'manager_override'
          ),
          now()
        );
      ELSE
        RAISE; -- Re-raise: INVENTORY_NEGATIVE without override, or any other error
      END IF;
    END;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint, boolean) TO authenticated;

-- =============================================================================
-- DOWN:
-- REVOKE EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint, boolean) FROM authenticated;
-- DROP FUNCTION IF EXISTS deplete_for_order_item(uuid, smallint, boolean);
-- (v1 2-arg signature in migration 002 remains; do not drop it here)
-- =============================================================================
