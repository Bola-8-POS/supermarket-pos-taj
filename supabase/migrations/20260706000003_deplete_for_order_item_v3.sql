-- =============================================================================
-- Phase 17: Modifier -> Inventory Rules
-- deplete_for_order_item v3: adds a modifier-driven depletion loop alongside
-- the existing recipe loop, so modifiers (e.g. "extra lime", "no ice") also
-- move stock.
--
-- Based on the CURRENT authoritative body in
-- 20260510000002_rpc_role_guards.sql §3 (NOT the stale
-- 20260428000004_deplete_for_order_item_v2.sql, which lacks the kitchen role
-- guard added later). Copied verbatim, then:
--
--   (D-04) The recipe lookup's `IF NOT FOUND THEN RETURN; END IF;` (which
--   exited the WHOLE function when a product had no recipe) is replaced with
--   an `IF FOUND THEN ... END IF;` wrapper around ONLY the existing recipe
--   loop. Modifier-driven depletion must fire independently of whether the
--   product has a base recipe (e.g. a bottled beer with an "extra lime"
--   modifier still depletes lime stock even though the bottle has no recipe).
--
--   A new modifier loop reads order_items.modifier_ids (uuid[], NOT NULL
--   DEFAULT '{}' - empty array is already a safe no-op, no NULL guard
--   needed) and applies each matching modifier_inventory_rules row's signed
--   delta, scaled by order_items.quantity like the recipe loop (D-01), with
--   NO yield_qty divisor (delta is absolute-per-line, not per-yield-unit).
--
--   Modifier-driven movements use ref_type='order_item_modifier' (distinct
--   from the recipe loop's ref_type='order_item') so the
--   (ref_type, ref_id, ingredient_id) partial unique index
--   (20260426000002_stock_movements_idempotency_index.sql) never collides
--   even when the same ingredient appears in both loops for the same
--   order_item - this keeps retries idempotent without any index/constraint
--   changes.
--
--   The modifier loop reuses the IDENTICAL p_allow_negative bypass +
--   audit_log 'stock_override' insert pattern as the recipe loop (D-05) -
--   no separate override mechanism for modifier-caused negative stock.
--
--   The kitchen-forbidden role guard at BEGIN and the trailing GRANT are
--   preserved unchanged (Pitfall 1: copying from the stale v2 file would
--   silently regress role enforcement).
--
-- Depends on: modifier_inventory_rules (20260706000002), record_stock_movement
-- (20260426000003), stock_movements idempotency index (20260426000002).
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

  -- 4. NEW: Deplete each ingredient mapped to a modifier on this order_item
  --    (D-01: scales by quantity like the recipe loop; NO yield_qty divisor —
  --    delta is absolute-per-line, not per-yield-unit. Empty v_modifier_ids
  --    yields zero loop iterations — recipe-only orders are unaffected,
  --    preserving SC-4.)
  FOR v_mod_item IN
    SELECT ingredient_id, delta FROM modifier_inventory_rules WHERE modifier_id = ANY(v_modifier_ids)
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
END;
$$;

GRANT EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint, boolean) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- Re-apply the prior body verbatim (the "3. deplete_for_order_item (v2)"
-- section of 20260510000002_rpc_role_guards.sql) via CREATE OR REPLACE
-- FUNCTION, then:
-- BEGIN;
-- GRANT EXECUTE ON FUNCTION deplete_for_order_item(uuid, smallint, boolean) TO authenticated;
-- COMMIT;
-- =============================================================================
