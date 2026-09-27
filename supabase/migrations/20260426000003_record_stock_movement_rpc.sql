-- =============================================================================
-- S3a-03: record_stock_movement transactional RPC
--
-- Atomically records a stock movement and updates ingredients.quantity_on_hand.
-- Uses SELECT FOR UPDATE to prevent concurrent quantity drift on hot ingredients.
-- SECURITY DEFINER: runs as function owner; auth.uid() is preserved by Supabase JWT.
--
-- Caller idempotency pattern (for depletion reasons):
--   catch error code '23505' (unique_violation) → treat as success (already recorded)
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION record_stock_movement(
  p_ingredient_id  uuid,
  p_delta          numeric,
  p_reason         text,
  p_ref_type       text,
  p_ref_id         uuid,
  p_notes          text DEFAULT NULL
)
RETURNS stock_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current  numeric;
  v_new      numeric;
  v_row      stock_movements;
  v_staff_id uuid;
BEGIN
  -- Capture calling user (SECURITY DEFINER preserves auth.uid() via JWT claims)
  v_staff_id := auth.uid();

  -- 1. Lock the ingredient row to prevent concurrent quantity drift
  SELECT quantity_on_hand INTO v_current
  FROM   ingredients
  WHERE  id = p_ingredient_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INGREDIENT_NOT_FOUND: ingredient % does not exist', p_ingredient_id;
  END IF;

  -- 2. Compute new quantity
  v_new := v_current + p_delta;

  -- 3. Negative-stock guard: correction and physical_count bypass the guard
  --    (they can legitimately drive qty below 0 to correct data errors)
  IF v_new < 0 AND p_reason NOT IN ('correction', 'physical_count') THEN
    RAISE EXCEPTION 'INVENTORY_NEGATIVE: result would be % for ingredient %', v_new, p_ingredient_id;
  END IF;

  -- 4. Insert the movement row
  INSERT INTO stock_movements (
    product_id,
    ingredient_id,
    quantity_delta,
    reason,
    ref_type,
    ref_id,
    staff_id,
    notes
  )
  VALUES (
    NULL,
    p_ingredient_id,
    p_delta,
    p_reason,
    p_ref_type,
    p_ref_id,
    v_staff_id,
    p_notes
  )
  RETURNING * INTO v_row;

  -- 5. Update ingredient quantity_on_hand atomically in the same transaction
  UPDATE ingredients
  SET    quantity_on_hand = v_new,
         updated_at       = now()
  WHERE  id = p_ingredient_id;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION record_stock_movement(uuid, numeric, text, text, uuid, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION record_stock_movement(uuid, numeric, text, text, uuid, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS record_stock_movement(uuid, numeric, text, text, uuid, text);
-- COMMIT;
-- =============================================================================
