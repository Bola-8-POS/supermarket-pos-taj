-- =============================================================================
-- Phase 27 (27-03 hardening): fix consume_open_unit's override-bypass path
-- violating inventory's non-negative CHECK constraint
--
-- Found by: 27-03 Scenario R3 (27-VALIDATION.md row 5) — "exhaustion with zero
-- packages, and the D-05 override". Fixture: no active unit,
-- inventory.quantity_on_hand = 0. Calling deplete_for_order_item with
-- p_allow_negative=true (the exact path useOverrideNegativeStock.ts drives
-- after manager PIN approval) raised a raw Postgres error instead of
-- resolving:
--
--   ERROR 23514: new row for relation "inventory" violates check constraint
--   "quantity_on_hand_non_negative"
--
-- Root cause: 20260729000003_consume_open_unit_rpc.sql's auto-open override
-- branch does `UPDATE inventory SET quantity_on_hand = quantity_on_hand - 1`
-- unconditionally when p_allow_negative bypasses the INVENTORY_NEGATIVE
-- guard. Its own comment claims this "lets the package count go negative" —
-- but unlike ingredients.quantity_on_hand (no non-negative constraint,
-- deliberately allowed to go negative under override per the existing
-- deplete_for_order_item ingredient-loop pattern), inventory.quantity_on_hand
-- carries a hard `CHECK (quantity_on_hand >= 0)` constraint
-- (quantity_on_hand_non_negative, 20260414000007_inventory.sql) that predates
-- Phase 27 and is shared by every product in the catalog, not just BOX
-- products. The override-bypass branch is only reachable when
-- v_qty_on_hand IS NULL OR v_qty_on_hand < 1 — i.e. exactly the case where
-- the decrement would go negative — so this branch could never succeed as
-- originally written; it was untested until this plan's R3 scenario.
--
-- Fix: floor the decrement at 0 with GREATEST(quantity_on_hand - 1, 0),
-- matching the schema's existing non-negative invariant instead of
-- contradicting it. The unit still opens under the override (the sale is not
-- blocked), and the bookkeeping stays honest at the floor rather than
-- attempting a value the schema has never permitted for this column. No
-- other line of the function changes.
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION consume_open_unit(
  p_product_id     uuid,     -- LOOSE product id (has parent_product_id set)
  p_qty            int,
  p_order_item_id  uuid,
  p_direction      smallint, -- +1 sale, -1 refund/void
  p_allow_negative boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent_id      uuid;
  v_per_package    int;
  v_remaining_qty  int := p_qty;
  v_unit           record;
  v_take           int;
  v_new_remaining  int;
  v_credited       int;
  v_discarded      int;
  v_new_unit_id    uuid;
  v_before         jsonb;
  v_after          jsonb;
  v_qty_on_hand    int;
  v_iterations     int := 0;
  v_max_iterations int := p_qty + 2;
BEGIN
  -- p_product_id is the LOOSE product; resolve its parent BOX product.
  SELECT parent_product_id INTO v_parent_id
  FROM   products
  WHERE  id = p_product_id;

  IF v_parent_id IS NULL THEN
    RETURN;  -- not an open-unit product; safe no-op for every other product
  END IF;

  SELECT units_per_package INTO v_per_package
  FROM   products
  WHERE  id = v_parent_id;

  IF v_per_package IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: parent product % has no units_per_package configured', v_parent_id;
  END IF;

  -- -------------------------------------------------------------------
  -- Refund/void: credit back to whichever unit is currently active.
  -- -------------------------------------------------------------------
  IF p_direction = -1 THEN
    SELECT * INTO v_unit
    FROM   open_units
    WHERE  product_id = v_parent_id AND status = 'active'
    FOR UPDATE;

    IF NOT FOUND THEN
      -- No active unit to credit — the physical pieces are already gone;
      -- resurrecting an exhausted row would fabricate stock. Audit the
      -- discard so the write-off is not silent.
      PERFORM record_audit(
        'open_unit.deplete',
        'open_unit',
        NULL,
        NULL,
        jsonb_build_object(
          'order_item_id', p_order_item_id,
          'direction', -1,
          'qty', p_qty,
          'credited', 0,
          'credit_discarded', p_qty
        ),
        'rpc'
      );
      RETURN;
    END IF;

    v_new_remaining := LEAST(v_unit.remaining_count + p_qty, v_per_package);
    v_credited := v_new_remaining - v_unit.remaining_count;
    v_discarded := p_qty - v_credited;

    v_before := to_jsonb(v_unit);

    UPDATE open_units
    SET    remaining_count = v_new_remaining,
           updated_at      = now()
    WHERE  id = v_unit.id;

    SELECT to_jsonb(o) INTO v_after FROM open_units o WHERE o.id = v_unit.id;

    PERFORM record_audit(
      'open_unit.deplete',
      'open_unit',
      v_unit.id,
      v_before,
      v_after || jsonb_build_object(
        'order_item_id', p_order_item_id,
        'direction', -1,
        'qty', p_qty,
        'credited', v_credited,
        'credit_discarded', v_discarded
      ),
      'rpc'
    );

    RETURN;
  END IF;

  -- -------------------------------------------------------------------
  -- Sale (p_direction = 1): consume, auto-opening/auto-transitioning as
  -- needed. May span multiple open_units rows for a single call.
  -- -------------------------------------------------------------------
  WHILE v_remaining_qty > 0 LOOP
    v_iterations := v_iterations + 1;
    IF v_iterations > v_max_iterations THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: consume_open_unit exceeded % iterations for product %', v_max_iterations, v_parent_id;
    END IF;

    SELECT * INTO v_unit
    FROM   open_units
    WHERE  product_id = v_parent_id AND status = 'active'
    FOR UPDATE;

    IF NOT FOUND THEN
      -- Auto-open: lock the parent's inventory row before deciding.
      SELECT quantity_on_hand INTO v_qty_on_hand
      FROM   inventory
      WHERE  product_id = v_parent_id
      FOR UPDATE;

      IF v_qty_on_hand IS NULL OR v_qty_on_hand < 1 THEN
        IF NOT p_allow_negative THEN
          RAISE EXCEPTION 'INVENTORY_NEGATIVE: no unopened package available for product %', v_parent_id;
        END IF;

        -- Bypass: open the unit anyway. inventory.quantity_on_hand carries a
        -- hard non-negative CHECK constraint (pre-existing, shared by every
        -- product) — floor the decrement at 0 rather than attempting a
        -- negative value the schema has never permitted for this column
        -- (fix: 20260730000001, found by 27-03 Scenario R3).
        UPDATE inventory
        SET    quantity_on_hand = GREATEST(quantity_on_hand - 1, 0),
               updated_at       = now()
        WHERE  product_id = v_parent_id;

        INSERT INTO open_units (product_id, remaining_count, status, opened_by)
        VALUES (v_parent_id, v_per_package, 'active', auth.uid())
        RETURNING id INTO v_new_unit_id;

        SELECT to_jsonb(o) INTO v_after FROM open_units o WHERE o.id = v_new_unit_id;

        PERFORM record_audit(
          'open_unit.override',
          'open_unit',
          v_new_unit_id,
          NULL,
          v_after || jsonb_build_object(
            'order_item_id', p_order_item_id,
            'reason', 'auto_open_with_no_unopened_package'
          ),
          'rpc'
        );

        PERFORM record_audit('open_unit.open', 'open_unit', v_new_unit_id, NULL, v_after, 'rpc');
      ELSE
        UPDATE inventory
        SET    quantity_on_hand = quantity_on_hand - 1,
               updated_at       = now()
        WHERE  product_id = v_parent_id;

        INSERT INTO open_units (product_id, remaining_count, status, opened_by)
        VALUES (v_parent_id, v_per_package, 'active', auth.uid())
        RETURNING id INTO v_new_unit_id;

        SELECT to_jsonb(o) INTO v_after FROM open_units o WHERE o.id = v_new_unit_id;

        PERFORM record_audit('open_unit.open', 'open_unit', v_new_unit_id, NULL, v_after, 'rpc');
      END IF;

      CONTINUE;  -- re-select the row just opened
    END IF;

    v_take := LEAST(v_remaining_qty, v_unit.remaining_count);
    v_new_remaining := v_unit.remaining_count - v_take;

    v_before := to_jsonb(v_unit);

    UPDATE open_units
    SET    remaining_count = v_new_remaining,
           status          = CASE WHEN v_new_remaining = 0 THEN 'exhausted' ELSE status END,
           closed_at       = CASE WHEN v_new_remaining = 0 THEN now() ELSE closed_at END,
           closed_reason   = CASE WHEN v_new_remaining = 0 THEN 'exhausted' ELSE closed_reason END,
           updated_at      = now()
    WHERE  id = v_unit.id;

    IF v_new_remaining = 0 THEN
      SELECT to_jsonb(o) INTO v_after FROM open_units o WHERE o.id = v_unit.id;
      PERFORM record_audit('open_unit.exhaust', 'open_unit', v_unit.id, v_before, v_after, 'rpc');
    END IF;

    v_remaining_qty := v_remaining_qty - v_take;
  END LOOP;

  -- Exactly one open_unit.deplete audit row per call (not per loop
  -- iteration), recorded against the last unit touched.
  PERFORM record_audit(
    'open_unit.deplete',
    'open_unit',
    v_unit.id,
    NULL,
    jsonb_build_object(
      'order_item_id', p_order_item_id,
      'direction', 1,
      'qty', p_qty
    ),
    'rpc'
  );
END;
$$;

COMMIT;

-- =============================================================================
-- DOWN:
-- Re-apply 20260729000003_consume_open_unit_rpc.sql's body verbatim via
-- CREATE OR REPLACE FUNCTION (restores the unconditional decrement that
-- violates quantity_on_hand_non_negative under override with zero box stock).
-- =============================================================================
