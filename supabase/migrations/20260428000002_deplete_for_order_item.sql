-- =============================================================================
-- Phase 4: deplete_for_order_item RPC (base version — v2 with p_allow_negative in migration 004)
--
-- Reads order_item → product → recipe → depletes each ingredient via record_stock_movement.
-- p_direction: +1 = sale (subtract stock), -1 = refund/void (add stock back).
--
-- No recipe for product: returns early (no depletion — beer, water, etc.).
-- Stock goes negative on sale: record_stock_movement raises INVENTORY_NEGATIVE
--   which propagates up through create_order_with_items and rolls back the transaction.
-- Idempotency: stock_movements has UNIQUE (ref_id, ingredient_id) — duplicate calls
--   produce 23505 unique_violation which callers treat as success (no-op).
--
-- SECURITY DEFINER: audit trail cannot be bypassed by client code (T-04-04).
-- Uses SELECT FOR UPDATE via record_stock_movement for concurrent write safety (T-04-05).
--
-- Depends on:
--   - 20260428000001_recipes_tables.sql (recipes, recipe_items)
--   - 20260426000003_record_stock_movement_rpc.sql (record_stock_movement signature)
--   - 20260426000002_stock_movements_idempotency_index.sql (UNIQUE ref_id+ingredient_id)
-- =============================================================================

-- UP:
CREATE OR REPLACE FUNCTION deplete_for_order_item(
  p_order_item_id  uuid,
  p_direction      smallint  -- +1 sale (subtract), -1 refund/void (add back)
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

    PERFORM record_stock_movement(
      v_item.ingredient_id,
      v_delta,
      v_reason,         -- 'sale' or 'refund'
      'order_item',     -- ref_type
      p_order_item_id,  -- ref_id (idempotency key — UNIQUE with ingredient_id)
      NULL              -- notes
    );
    -- INVENTORY_NEGATIVE exception propagates up on sale direction → rollback.
    -- 23505 unique_violation (idempotent re-call) propagates up — caller must handle.
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint) TO authenticated;

-- =============================================================================
-- DOWN:
-- REVOKE EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint) FROM authenticated;
-- DROP FUNCTION IF EXISTS deplete_for_order_item(uuid, smallint);
-- =============================================================================
