-- =============================================================================
-- Phase 4: add_combo_to_tab — adds ingredient depletion for inserted child order_items
--
-- Extends add_combo_to_tab to deplete ingredients for each combo child order_item
-- after all children are inserted. INVENTORY_NEGATIVE propagates up and rolls back
-- the entire combo insertion (transaction atomicity preserved — same as
-- create_order_with_items depletion behavior).
--
-- Implementation: collects inserted child order_item IDs via a temp array, then
-- calls deplete_for_order_item(id, 1::smallint) for each in a depletion loop.
--
-- Depends on:
--   - 20260428000002_deplete_for_order_item.sql (v1, 2-arg signature)
-- =============================================================================

-- UP: add_combo_to_tab with depletion
BEGIN;

CREATE OR REPLACE FUNCTION add_combo_to_tab(
  p_combo_product_id      uuid,
  p_tab_id                uuid,
  p_slot_selections       jsonb,
  p_override_availability boolean DEFAULT false,
  p_override_reason       text    DEFAULT null
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_combo_product     record;
  v_order_id          uuid;
  v_parent_item_id    uuid;
  v_slot              record;
  v_option            record;
  v_selection         jsonb;
  v_child_product     record;
  v_slot_id           uuid;
  v_child_product_id  uuid;
  v_qty               integer;
  v_parent_price      numeric(10,2);
  v_total_children    integer;
  v_filled_required   integer;
  v_required_count    integer;
  v_staff_id          uuid;
  i                   integer;
  v_child_item_id     uuid;
  v_child_item_ids    uuid[];
  v_combo_item_depl   record;
BEGIN
  -- Capture calling user for orders.staff_id (SECURITY DEFINER preserves auth.uid())
  v_staff_id := auth.uid();

  -- Initialize child item ids collector
  v_child_item_ids := ARRAY[]::uuid[];

  -- 1. Verify combo product exists and is_combo=true
  SELECT * INTO v_combo_product
  FROM products
  WHERE id = p_combo_product_id AND is_combo = true AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_CHILD: Combo product % not found or not active', p_combo_product_id;
  END IF;

  -- 2. Verify availability (unless overridden)
  IF NOT p_override_availability THEN
    IF NOT is_combo_available(p_combo_product_id, now()) THEN
      RAISE EXCEPTION 'COMBO_UNAVAILABLE: Combo % is not available at this time', p_combo_product_id;
    END IF;
  END IF;

  -- 3. If override: write audit trail
  -- audit_log table is not yet guaranteed to exist; use a DO block to swallow missing-table error.
  -- Once audit_log is created in a future migration, this will automatically start writing.
  IF p_override_availability THEN
    BEGIN
      INSERT INTO audit_log (action, entity_type, entity_id, details, created_at)
      VALUES (
        'combo_availability_override',
        'product',
        p_combo_product_id,
        jsonb_build_object(
          'tab_id', p_tab_id,
          'reason', p_override_reason,
          'overridden_at', now()
        ),
        now()
      );
    EXCEPTION
      WHEN undefined_table THEN
        -- audit_log table does not exist yet; silently continue
        -- TODO: remove this guard once audit_log migration is applied
        NULL;
    END;
  END IF;

  -- 4. Validate slot_selections array against combo_slots
  v_required_count := 0;
  v_filled_required := 0;

  FOR v_slot IN
    SELECT * FROM combo_slots WHERE combo_product_id = p_combo_product_id ORDER BY sort_order
  LOOP
    -- Find the selection for this slot
    v_selection := null;
    FOR i IN 0..jsonb_array_length(p_slot_selections) - 1
    LOOP
      IF (p_slot_selections->i->>'slotId')::uuid = v_slot.id THEN
        v_selection := p_slot_selections->i;
        EXIT;
      END IF;
    END LOOP;

    IF v_slot.is_required THEN
      v_required_count := v_required_count + 1;
      IF v_selection IS NULL THEN
        RAISE EXCEPTION 'SLOT_MIN_MAX_VIOLATION: Required slot % (%) not filled', v_slot.id, v_slot.label;
      END IF;
    END IF;

    IF v_selection IS NOT NULL THEN
      v_qty := (v_selection->>'qty')::integer;

      -- Check qty within min..max
      IF v_qty < v_slot.min_qty OR v_qty > v_slot.max_qty THEN
        RAISE EXCEPTION 'SLOT_MIN_MAX_VIOLATION: Slot % qty % outside range %..%',
          v_slot.id, v_qty, v_slot.min_qty, v_slot.max_qty;
      END IF;

      -- For product slots, validate child_product_id
      IF v_slot.slot_type = 'product' THEN
        v_child_product_id := (v_selection->>'childProductId')::uuid;

        -- child must be in combo_slot_options
        IF NOT EXISTS (
          SELECT 1 FROM combo_slot_options
          WHERE combo_slot_id = v_slot.id AND child_product_id = v_child_product_id
        ) THEN
          RAISE EXCEPTION 'INVALID_CHILD: Product % is not a valid option for slot %',
            v_child_product_id, v_slot.id;
        END IF;

        -- Defense-in-depth: child must not be a combo (trigger covers at insert, RPC double-checks)
        SELECT * INTO v_child_product FROM products WHERE id = v_child_product_id;
        IF v_child_product.is_combo THEN
          RAISE EXCEPTION 'NESTED_COMBO_FORBIDDEN: Product % is a combo; cannot be a child',
            v_child_product_id;
        END IF;

        IF v_slot.is_required THEN
          v_filled_required := v_filled_required + 1;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- 5. Determine parent price: combo_price_override OR sum of children base prices
  IF v_combo_product.combo_price_override IS NOT NULL THEN
    v_parent_price := v_combo_product.combo_price_override;
  ELSE
    SELECT COALESCE(SUM(p.base_price * (sel->>'qty')::integer), 0)
    INTO v_parent_price
    FROM jsonb_array_elements(p_slot_selections) AS sel
    JOIN products p ON p.id = (sel->>'childProductId')::uuid
    WHERE sel->>'childProductId' IS NOT NULL;
  END IF;

  -- 6. Find or create an open order for this tab
  SELECT o.id INTO v_order_id
  FROM orders o
  WHERE o.tab_id = p_tab_id AND o.status = 'pending'
  ORDER BY o.created_at DESC
  LIMIT 1;

  IF v_order_id IS NULL THEN
    INSERT INTO orders (tab_id, staff_id, status, created_at)
    VALUES (p_tab_id, v_staff_id, 'pending', now())
    RETURNING id INTO v_order_id;
  END IF;

  -- 7. Insert parent order_item (is_combo=true, price=combo price)
  -- Note: order_items has no status column; kds_status defaults to 'pending'.
  -- parent_order_item_id=null identifies this as the parent of the combo group.
  INSERT INTO order_items (
    order_id, product_id, quantity, unit_price,
    parent_order_item_id, combo_slot_id, created_at
  ) VALUES (
    v_order_id, p_combo_product_id, 1, v_parent_price,
    null, null, now()
  ) RETURNING id INTO v_parent_item_id;

  -- 8. Insert child order_items for each slot selection
  FOR v_slot IN
    SELECT * FROM combo_slots WHERE combo_product_id = p_combo_product_id ORDER BY sort_order
  LOOP
    -- Find selection for this slot
    v_selection := null;
    FOR i IN 0..jsonb_array_length(p_slot_selections) - 1
    LOOP
      IF (p_slot_selections->i->>'slotId')::uuid = v_slot.id THEN
        v_selection := p_slot_selections->i;
        EXIT;
      END IF;
    END LOOP;

    IF v_selection IS NULL THEN
      CONTINUE;  -- optional slot not filled
    END IF;

    v_qty := (v_selection->>'qty')::integer;

    IF v_slot.slot_type = 'product' THEN
      v_child_product_id := (v_selection->>'childProductId')::uuid;

      -- Insert N child order_items (price=0; parent holds the combo total)
      -- Collect inserted IDs for depletion loop below.
      FOR i IN 1..v_qty LOOP
        INSERT INTO order_items (
          order_id, product_id, quantity, unit_price,
          parent_order_item_id, combo_slot_id, created_at
        ) VALUES (
          v_order_id, v_child_product_id, 1, 0,
          v_parent_item_id, v_slot.id, now()
        ) RETURNING id INTO v_child_item_id;

        v_child_item_ids := v_child_item_ids || v_child_item_id;
      END LOOP;

    ELSIF v_slot.slot_type = 'pool_time' THEN
      -- Look up prepaid_minutes from the slot option for this pool_time slot
      SELECT prepaid_minutes INTO v_qty
      FROM combo_slot_options
      WHERE combo_slot_id = v_slot.id
      LIMIT 1;

      -- Pool session creation:
      -- pool_sessions.table_id is NOT NULL — a specific pool table must be assigned
      -- by the bartender when starting the session. The start-pool-timer feature
      -- handles prepaid_minutes (see plan 02-02 pool-billing extension).
      --
      -- Design decision: we record prepaid intent on the parent order_item via
      -- source_order_item_id linkage. The bartender assigns a table and starts the
      -- session (which then applies the prepaid_minutes deduction in billing logic).
      --
      -- No pool_sessions INSERT here — the start-pool-timer feature is responsible
      -- for creating the session row with the correct table_id.
      --
      -- If operator workflow changes (pre-assign table at order time), add a
      -- pool_sessions INSERT in a follow-up migration after making table_id nullable.
      NULL;  -- intentional no-op for pool_time slots
    END IF;
  END LOOP;

  -- Phase 4: Deplete ingredients for each inserted combo child order_item.
  -- INVENTORY_NEGATIVE propagates up and rolls back the entire combo insertion.
  FOR v_combo_item_depl IN
    SELECT unnest(v_child_item_ids) AS id
  LOOP
    PERFORM deplete_for_order_item(v_combo_item_depl.id, 1::smallint);
  END LOOP;

  RETURN v_parent_item_id;
END;
$$;

-- Grant execute to authenticated role (SECURITY DEFINER runs as function owner)
GRANT EXECUTE ON FUNCTION add_combo_to_tab(uuid, uuid, jsonb, boolean, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- REVOKE EXECUTE ON FUNCTION add_combo_to_tab(uuid, uuid, jsonb, boolean, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS add_combo_to_tab(uuid, uuid, jsonb, boolean, text);
-- Restore original version from 20260425000005_add_combo_to_tab_rpc.sql
-- =============================================================================
