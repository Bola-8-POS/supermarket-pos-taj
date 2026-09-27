-- =============================================================================
-- Phase 1 (01-09): deplete_for_order_item v6 — drop recipe + modifier-rule
-- branches, keep plain-product resolution and open-unit depletion.
--
-- Highest-risk change in this plan (Pitfall 3, RESEARCH.md): v5
-- (20260729000004_deplete_for_order_item_v5_open_units.sql) interleaves
-- recipe-loop depletion (steps 2-3), modifier-inventory-rule depletion
-- (step 4), and open-unit depletion (step 5) in one function body. This
-- migration starts from v5's body verbatim and removes ONLY steps 2-4 — step
-- 1 (resolve order_item) and step 5 (open-unit branch, PERFORM
-- consume_open_unit) are unchanged, preserving Phase 2's CHK-05 dependency.
--
-- Removed unused locals: v_recipe_id, v_yield_qty, v_item, v_delta,
-- v_mod_item, v_mod_delta (only used by the removed loops), v_modifier_ids
-- (only used by step 1's SELECT INTO and step 4's WHERE clause — step 4 is
-- gone, and nothing else in the v5 body reads it), and v_reason (only used
-- by the record_stock_movement calls inside the removed loops —
-- consume_open_unit does not take a reason argument).
--
-- D-16: role-guard error message updated from "bartender or higher
-- required" to "cashier or higher required" for RBAC rename consistency.
-- =============================================================================

-- UP:
BEGIN;

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
  v_product_id    uuid;
  v_qty           int;
BEGIN
  -- Role guard: kitchen cannot call deplete_for_order_item directly
  IF get_user_role() IS NULL OR get_user_role() = 'kitchen' THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: cashier or higher required to call deplete_for_order_item';
  END IF;

  -- 1. Resolve order_item → product_id + quantity (unchanged from v5)
  SELECT product_id, quantity
    INTO v_product_id, v_qty
    FROM order_items
   WHERE id = p_order_item_id;

  IF NOT FOUND THEN RETURN; END IF;

  -- 2. Open-unit branch (unchanged from v5, Phase 27 27-02). consume_open_unit
  --    no-ops for any product whose parent_product_id is NULL, so this is
  --    safe to run unconditionally — every plain-product order item is
  --    unaffected.
  IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id AND parent_product_id IS NOT NULL) THEN
    PERFORM consume_open_unit(v_product_id, v_qty, p_order_item_id, p_direction, p_allow_negative);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint, boolean) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- Re-apply v5's body verbatim (20260729000004_deplete_for_order_item_v5_open_units.sql)
-- via CREATE OR REPLACE FUNCTION — this requires the recipes/ingredients/
-- modifier_inventory_rules tables to exist again first (see the paired
-- schema-drop migration's own DOWN section), then:
-- BEGIN;
-- GRANT EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint, boolean) TO authenticated;
-- COMMIT;
-- =============================================================================
