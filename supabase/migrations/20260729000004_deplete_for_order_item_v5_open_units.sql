-- =============================================================================
-- Phase 27 (27-02): deplete_for_order_item v5 — open-unit branch
--
-- v4's body (20260707000001) is copied verbatim — same signature, same role
-- guard, same recipe loop, same modifier loop with its GROUP BY ingredient_id
-- CR-01 fix, same override branches including their existing legacy
-- INSERT INTO audit_log calls (left untouched — this plan does not migrate
-- pre-existing code paths, only adds a new branch).
--
-- New: one branch after the modifier loop that PERFORMs consume_open_unit
-- when the order item's product is a loose-piece product
-- (products.parent_product_id IS NOT NULL). consume_open_unit itself no-ops
-- for every other product, so this is safe to add unconditionally.
--
-- This gets voiding/refunding/negative-stock-override of an open-unit sale
-- for free, with zero new client wiring: create_order_with_items already
-- PERFORMs this function, CartPanel already catches INVENTORY_NEGATIVE and
-- opens ManagerPinDialog, and useOverrideNegativeStock already re-drives
-- depletion with p_allow_negative: true (27-RESEARCH.md Anti-Patterns,
-- resolved Open Question 1).
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
  v_recipe_id     uuid;
  v_yield_qty     numeric;
  v_item          record;
  v_delta         numeric;
  v_reason        text;
  v_modifier_ids  uuid[];
  v_mod_item      record;
  v_mod_delta     numeric;
BEGIN
  -- Role guard: kitchen cannot call deplete_for_order_item directly
  IF get_user_role() IS NULL OR get_user_role() = 'kitchen' THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: bartender or higher required to call deplete_for_order_item';
  END IF;

  -- 1. Resolve order_item → product_id + quantity + modifier_ids
  SELECT product_id, quantity, modifier_ids
    INTO v_product_id, v_qty, v_modifier_ids
    FROM order_items
   WHERE id = p_order_item_id;

  IF NOT FOUND THEN RETURN; END IF;

  v_reason := CASE WHEN p_direction = 1 THEN 'sale' ELSE 'refund' END;

  -- 2. Find recipe for product; no recipe → skip the recipe loop only
  --    (D-04: modifier-driven depletion below must still run for
  --    recipe-less products, e.g. a bottled beer with an "extra lime"
  --    modifier).
  SELECT id, yield_qty
    INTO v_recipe_id, v_yield_qty
    FROM recipes
   WHERE product_id = v_product_id;

  IF FOUND THEN
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
  END IF;

  -- 4. Deplete each ingredient mapped to a modifier on this order_item
  --    (D-01: scales by quantity like the recipe loop; NO yield_qty divisor —
  --    delta is absolute-per-line, not per-yield-unit. Empty v_modifier_ids
  --    yields zero loop iterations — recipe-only orders are unaffected,
  --    preserving SC-4.)
  --    GROUP BY ingredient_id: two different modifiers on the same order item
  --    can both target the same ingredient (e.g. "Extra Lime" + "Heavy
  --    Garnish"). Without aggregating first, the second record_stock_movement
  --    call for that ingredient would collide with the
  --    (ref_type, ref_id, ingredient_id) partial unique index and abort the
  --    whole RPC (CR-01, Phase 17 code review — fixed here in v4).
  FOR v_mod_item IN
    SELECT ingredient_id, SUM(delta) AS delta
      FROM modifier_inventory_rules
     WHERE modifier_id = ANY(v_modifier_ids)
     GROUP BY ingredient_id
  LOOP
    v_mod_delta := -p_direction::numeric * v_qty::numeric * v_mod_item.delta;

    BEGIN
      PERFORM record_stock_movement(
        v_mod_item.ingredient_id,
        v_mod_delta,
        v_reason,                 -- 'sale' or 'refund' (shared with recipe loop)
        'order_item_modifier',    -- ref_type — distinct from recipe loop's 'order_item'
                                   -- so the (ref_type, ref_id, ingredient_id) partial
                                   -- unique index never collides even when the same
                                   -- ingredient appears in both loops.
        p_order_item_id,          -- ref_id (idempotency key — UNIQUE with ingredient_id)
        NULL                      -- notes
      );
    EXCEPTION WHEN OTHERS THEN
      -- D-05: identical override bypass as the recipe loop above
      IF p_allow_negative AND SQLERRM LIKE '%INVENTORY_NEGATIVE%' THEN
        UPDATE ingredients
           SET quantity_on_hand = quantity_on_hand + v_mod_delta
         WHERE id = v_mod_item.ingredient_id;

        INSERT INTO audit_log (action, entity_type, entity_id, details, created_at)
        VALUES (
          'stock_override',
          'order_item',
          p_order_item_id,
          jsonb_build_object(
            'ingredient_id', v_mod_item.ingredient_id,
            'delta', v_mod_delta,
            'reason', 'manager_override'
          ),
          now()
        );
      ELSE
        RAISE;
      END IF;
    END;
  END LOOP;

  -- 5. NEW (Phase 27, 27-02): open-unit branch. consume_open_unit no-ops for
  --    any product whose parent_product_id is NULL, so this is safe to add
  --    unconditionally — every existing product/test path is unaffected.
  IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id AND parent_product_id IS NOT NULL) THEN
    PERFORM consume_open_unit(v_product_id, v_qty, p_order_item_id, p_direction, p_allow_negative);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint, boolean) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- Re-apply the v4 body verbatim
-- (20260707000001_deplete_for_order_item_v4_fix_modifier_ingredient_collision.sql)
-- via CREATE OR REPLACE FUNCTION, then:
-- BEGIN;
-- GRANT EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint, boolean) TO authenticated;
-- COMMIT;
-- =============================================================================
