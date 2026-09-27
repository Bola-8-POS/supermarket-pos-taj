-- =============================================================================
-- Phase 13: RPC role guards for 4 SECURITY DEFINER functions
--
-- Patches 4 sensitive RPCs to enforce role-based access at function entry.
--   1. process_payment_atomic — uses p_staff_id lookup (NOT auth.uid()) because
--      this RPC is called via service_role key from an edge function where
--      auth.uid() returns NULL.
--   2. process_refund — replaces broken auth.uid() pattern with get_user_role()
--      NOT IN ('manager', 'admin') guard.
--   3. deplete_for_order_item (v2) — adds kitchen block at BEGIN entry.
--   4. add_combo_to_tab — adds kitchen block at BEGIN entry.
--
-- Applied 2026-04-28 via Supabase Management API (apply_migration MCP) due to
-- supabase CLI v2.90.0 splitter bug rejecting multi-statement function migrations
-- with SQLSTATE 42601 "cannot insert multiple commands into a prepared statement".
-- Functions 1-4 were applied as 4 separate statements; this file is the
-- canonical single-source artifact.
--
-- Sources:
--   process_payment_atomic: 20260429000000_process_payment_close_when_fully_paid.sql
--   process_refund:          20260427000005_fix_process_refund_idempotency.sql
--   deplete_for_order_item:  20260428000004_deplete_for_order_item_v2.sql
--   add_combo_to_tab:        20260428000005_add_combo_to_tab_depletion.sql
-- =============================================================================

-- 1. process_payment_atomic
-- =============================================================================
CREATE OR REPLACE FUNCTION public.process_payment_atomic(
  p_tab_id UUID,
  p_staff_id UUID,
  p_amount NUMERIC,
  p_tip_amount NUMERIC,
  p_method TEXT,
  p_idempotency_key TEXT,
  p_tendered_amount NUMERIC DEFAULT NULL,
  p_reference_number TEXT DEFAULT NULL,
  p_rappi_order_id TEXT DEFAULT NULL,
  p_discount_scope TEXT DEFAULT NULL,
  p_discount_type TEXT DEFAULT NULL,
  p_discount_value NUMERIC DEFAULT NULL,
  p_discount_amount NUMERIC DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role user_role;
  v_existing_id UUID;
  v_existing_tab UUID;
  v_tab_status tab_status;
  v_rappi_tab TEXT;
  v_total NUMERIC;
  v_payment_id UUID;
  v_method payment_method;
  v_open_pool INT;
  v_tab_updated INT;
  v_owed NUMERIC;
  v_paid_line NUMERIC;
BEGIN
  -- Role guard: check p_staff_id role (not auth.uid() — called via service_role edge function)
  SELECT role INTO v_caller_role FROM profiles WHERE id = p_staff_id;
  IF v_caller_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_REQUIRED', 'message', 'Authentication required');
  END IF;
  IF v_caller_role = 'kitchen' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN', 'message', 'Kitchen role cannot process payments');
  END IF;

  IF p_method NOT IN ('cash', 'card', 'rappi') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Payment method must be cash, card, or rappi');
  END IF;

  v_method := p_method::payment_method;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_staff_id AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Staff not found or inactive');
  END IF;

  SELECT id, tab_id INTO v_existing_id, v_existing_tab
  FROM payments
  WHERE idempotency_key = p_idempotency_key
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    IF v_existing_tab IS DISTINCT FROM p_tab_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_MISMATCH', 'message', 'Idempotency key belongs to another tab');
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'paymentId', v_existing_id);
  END IF;

  SELECT status, rappi_order_id
  INTO v_tab_status, v_rappi_tab
  FROM tabs
  WHERE id = p_tab_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_FOUND', 'message', 'Tab not found');
  END IF;

  IF v_tab_status IS DISTINCT FROM 'open'::tab_status THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open');
  END IF;

  SELECT COUNT(*)::INT INTO v_open_pool
  FROM pool_sessions
  WHERE tab_id = p_tab_id AND stopped_at IS NULL;

  IF v_open_pool > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'POOL_SESSION_ACTIVE', 'message', 'Stop pool session before payment');
  END IF;

  IF p_method = 'rappi' THEN
    IF v_rappi_tab IS NULL OR v_rappi_tab IS DISTINCT FROM p_rappi_order_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RAPPI_ORDER_MISMATCH', 'message', 'Rappi order id does not match tab');
    END IF;
  END IF;

  v_total := ROUND(p_amount + p_tip_amount, 2);

  IF p_method = 'cash' THEN
    IF p_tendered_amount IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_REQUIRED', 'message', 'Tendered amount required for cash');
    END IF;
    IF ROUND(p_tendered_amount, 2) < v_total THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_TENDER', 'message', 'Tendered amount is less than total');
    END IF;
  ELSE
    IF p_tendered_amount IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_NOT_ALLOWED', 'message', 'Tendered amount is only for cash payments');
    END IF;
  END IF;

  INSERT INTO payments (
    tab_id, amount, tip_amount, method, processed_by,
    square_payment_id, square_receipt_url, tendered_amount,
    reference_number, idempotency_key,
    discount_scope, discount_type, discount_value, discount_amount
  ) VALUES (
    p_tab_id, ROUND(p_amount, 2), ROUND(p_tip_amount, 2), v_method, p_staff_id,
    NULL, NULL,
    CASE WHEN p_method = 'cash' THEN ROUND(p_tendered_amount, 2) ELSE NULL END,
    NULLIF(TRIM(p_reference_number), ''), p_idempotency_key,
    p_discount_scope, p_discount_type, p_discount_value, p_discount_amount
  )
  RETURNING id INTO v_payment_id;

  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_owed
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id
    AND oi.parent_order_item_id IS NULL;

  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0) INTO v_paid_line
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false;

  IF v_paid_line + 0.0001 >= v_owed THEN
    UPDATE tabs
    SET status = 'paid'::tab_status, closed_at = NOW(), updated_at = NOW()
    WHERE id = p_tab_id AND status = 'open'::tab_status;

    GET DIAGNOSTICS v_tab_updated = ROW_COUNT;

    IF v_tab_updated = 0 THEN
      DELETE FROM payments WHERE id = v_payment_id;
      RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open or was already closed');
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'paymentId', v_payment_id);
EXCEPTION
  WHEN unique_violation THEN
    SELECT id INTO v_existing_id FROM payments WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'paymentId', v_existing_id);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'message', 'Duplicate payment');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', 'Payment failed');
END;
$$;

REVOKE ALL ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) TO service_role;


-- =============================================================================
-- 2. process_refund
-- =============================================================================
CREATE OR REPLACE FUNCTION process_refund(
  p_original_payment_id uuid,
  p_items               jsonb,   -- [{order_item_id, qty, amount, restock}]
  p_reason              text,
  p_manager_pin         text     -- not used server-side; PIN already verified by ManagerPinDialog
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_staff_id         uuid;
  v_payment          record;
  v_already_refunded numeric;
  v_refund_total     numeric;
  v_refund_id        uuid;
  v_item             jsonb;
BEGIN
  -- 1. Verify caller is manager or admin (standardized get_user_role() pattern)
  IF get_user_role() NOT IN ('manager', 'admin') THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  -- Capture calling user for audit_log and refunds.created_by
  v_staff_id := auth.uid();

  -- 2. Get original payment (must not itself be a refund)
  SELECT * INTO v_payment FROM payments
  WHERE id = p_original_payment_id AND is_refund = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: payment % not found or is itself a refund', p_original_payment_id;
  END IF;

  -- 3. Compute already-refunded amount for this original payment
  SELECT COALESCE(SUM(r.amount), 0) INTO v_already_refunded
  FROM refunds r
  WHERE r.original_payment_id = p_original_payment_id;

  -- 4. Compute new refund total from items
  SELECT SUM((item->>'amount')::numeric) INTO v_refund_total
  FROM jsonb_array_elements(p_items) AS item;

  -- 5. Over-refund guard (T-06-05)
  IF v_refund_total > (v_payment.amount - v_already_refunded) THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_ORIGINAL: refund % exceeds remaining refundable amount %',
      v_refund_total, (v_payment.amount - v_already_refunded);
  END IF;

  -- 6. Insert refund record
  INSERT INTO refunds (original_payment_id, reason, amount, created_by)
  VALUES (p_original_payment_id, p_reason, v_refund_total, v_staff_id)
  RETURNING id INTO v_refund_id;

  -- 7. Insert refund_items + optionally call deplete_for_order_item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- Verify item belongs to original payment's tab (T-06-07)
    IF NOT EXISTS (
      SELECT 1 FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = (v_item->>'order_item_id')::uuid
        AND o.tab_id = v_payment.tab_id
    ) THEN
      RAISE EXCEPTION 'ITEM_NOT_IN_ORIGINAL_ORDER: item % not in payment''s tab',
        v_item->>'order_item_id';
    END IF;

    INSERT INTO refund_items (refund_id, order_item_id, qty, amount, restock)
    VALUES (
      v_refund_id,
      (v_item->>'order_item_id')::uuid,
      (v_item->>'qty')::integer,
      (v_item->>'amount')::numeric,
      (v_item->>'restock')::boolean
    );

    -- Ledger reversal: restock=true calls deplete_for_order_item with negative qty
    -- Phase 4 stub: graceful fallback when function not yet defined (T-06-07 pitfall 7)
    IF (v_item->>'restock')::boolean THEN
      BEGIN
        PERFORM deplete_for_order_item((v_item->>'order_item_id')::uuid, -1);
      EXCEPTION WHEN undefined_function THEN
        -- Phase 4 not yet deployed: log and continue
        NULL;
      END;
    END IF;
  END LOOP;

  -- 8. Insert negative payment row (is_refund=true — valid via amount_positive CHECK: amount > 0 OR is_refund = true)
  --    idempotency_key: 'refund-' prefix + refund UUID ensures uniqueness and is NOT NULL safe.
  INSERT INTO payments (tab_id, amount, tip_amount, method, processed_at, processed_by, is_refund, refund_id, idempotency_key)
  VALUES (
    v_payment.tab_id,
    -v_refund_total,
    0,
    v_payment.method,
    now(),
    v_staff_id,
    true,
    v_refund_id,
    'refund-' || v_refund_id::text
  );

  -- 9. Audit log (graceful fallback if audit_log table not yet created)
  BEGIN
    INSERT INTO audit_log (action, entity_type, entity_id, staff_id, details)
    VALUES (
      'refund',
      'payment',
      p_original_payment_id,
      v_staff_id,
      jsonb_build_object('refund_id', v_refund_id, 'amount', v_refund_total)
    );
  EXCEPTION WHEN undefined_table THEN
    NULL;  -- audit_log added by future migration
  END;

  RETURN v_refund_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_refund(uuid, jsonb, text, text) TO authenticated;


-- =============================================================================
-- 3. deplete_for_order_item (v2)
-- =============================================================================
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
  -- Role guard: kitchen cannot call deplete_for_order_item directly
  IF get_user_role() IS NULL OR get_user_role() = 'kitchen' THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: bartender or higher required to call deplete_for_order_item';
  END IF;

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
-- 4. add_combo_to_tab
-- =============================================================================
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
  -- Role guard: kitchen cannot add combos to tabs
  IF get_user_role() IS NULL OR get_user_role() = 'kitchen' THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: bartender or higher required to add combos';
  END IF;

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
