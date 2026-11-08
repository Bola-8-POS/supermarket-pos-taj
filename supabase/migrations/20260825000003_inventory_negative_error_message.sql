-- =============================================================================
-- Fixes the DIRECT_SALE_FAILED raw-Postgres-error leak documented in
-- .planning/phases/17-e2e-suite-overhaul/deferred-items.md: selling the
-- last unit of a plain (non-open-unit) product surfaced a raw
-- "violates check constraint \"quantity_on_hand_non_negative\"" string to
-- the checkout UI. decrement_inventory_on_order_item() had no guard around
-- its UPDATE. This wraps it in an exception handler that raises a
-- translated-ready 'INVENTORY_NEGATIVE: <product name>' message, mirroring
-- the existing prefix convention already used by the open-unit path
-- (src/entities/open-unit/model/queries.ts:35, message.startsWith('INVENTORY_NEGATIVE')).
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION decrement_inventory_on_order_item()
RETURNS TRIGGER AS $$
DECLARE
  v_sold_by_weight boolean;
  v_decrement int;
  v_product_name text;
BEGIN
  SELECT sold_by_weight INTO v_sold_by_weight FROM products WHERE id = NEW.product_id;
  v_decrement := CASE WHEN COALESCE(v_sold_by_weight, false) THEN COALESCE(NEW.weight_grams, 0) ELSE NEW.quantity END;

  BEGIN
    UPDATE inventory
    SET quantity_on_hand = quantity_on_hand - v_decrement
    WHERE product_id = NEW.product_id;
  EXCEPTION WHEN check_violation THEN
    SELECT name INTO v_product_name FROM products WHERE id = NEW.product_id;
    RAISE EXCEPTION 'INVENTORY_NEGATIVE: %', COALESCE(v_product_name, NEW.product_id::text);
  END;

  INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id)
  SELECT NEW.product_id, -v_decrement, 'sale', o.staff_id
  FROM orders o
  WHERE o.id = NEW.order_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

COMMIT;

-- =============================================================================
-- DOWN: re-apply the prior (unguarded) definition from
-- supabase/migrations/20260814000001_loose_weight_items.sql if this needs
-- to be rolled back.
-- =============================================================================
