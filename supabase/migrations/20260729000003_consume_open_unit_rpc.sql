-- =============================================================================
-- Phase 27 (27-02): consume_open_unit RPC
--
-- Atomically decrements (sale, p_direction=1) or credits back (refund/void,
-- p_direction=-1) an open_units row for a loose-piece product's parent BOX
-- product. Auto-opens a fresh unit from unopened package stock when the
-- active unit is exhausted or none exists yet (SC-2).
--
-- p_product_id is the LOOSE product's id (the one actually sold to the
-- customer). If the product is not a loose-piece product (no
-- parent_product_id), this is a no-op — that is what makes the new branch in
-- deplete_for_order_item v5 safe for every other product in the catalog.
--
-- No independent role guard: this function is reachable ONLY from inside
-- deplete_for_order_item, which already enforces AUTH_FORBIDDEN for
-- null-role/kitchen callers (27-RESEARCH.md Anti-Patterns / Open Question 1).
-- Deliberately NOT granted to `authenticated` — there is no client call site.
--
-- Row-locking convention: SELECT ... FOR UPDATE before every mutation,
-- mirroring record_stock_movement (20260426000003). The open_units row and,
-- on auto-open, the parent's inventory row are both locked this way — the
-- client-side unlocked read-then-write in
-- src/entities/inventory/model/queries.ts is a known pre-existing race and is
-- deliberately NOT mirrored here (27-RESEARCH.md Pitfall 1's sibling note).
--
-- Multi-quantity loose-piece lines (a single order_items.quantity > 1) can
-- span more than one open_units row — the WHILE loop below consumes
-- LEAST(remaining, current unit's remaining_count) per iteration and
-- auto-transitions to a freshly-opened unit when the current one is
-- exhausted mid-loop (27-RESEARCH.md Pitfall 3 / resolved Open Question 2).
--
-- Refund/void (p_direction=-1) credits back to whichever unit is currently
-- active, capped at units_per_package, discarding any remainder — resolved
-- Open Question 3. If no unit is active, the credit is discarded (never
-- resurrects an exhausted unit) but the discard is still audit-logged so the
-- write-off is not silent.
--
-- All lifecycle events go through record_audit()/audit_logs (Phase 14), never
-- the legacy singular audit_log table (27-RESEARCH.md Pitfall 1).
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

        -- Bypass: open the unit anyway, let the package count go negative.
        UPDATE inventory
        SET    quantity_on_hand = quantity_on_hand - 1,
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
-- BEGIN;
-- DROP FUNCTION IF EXISTS consume_open_unit(uuid, int, uuid, smallint, boolean);
-- COMMIT;
-- =============================================================================
