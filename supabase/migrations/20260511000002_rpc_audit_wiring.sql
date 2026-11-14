-- =============================================================================
-- Phase 14-03: Wire record_audit() into sensitive SECURITY DEFINER RPCs
--
-- This migration patches 4 sensitive RPCs to call record_audit() post-mutation,
-- pre-RETURN, on the SUCCESS path. Validation-error returns are NOT audited
-- (they are no-ops — no state was changed). Audit failures are non-fatal:
-- record_audit() catches its own exceptions and returns NULL.
--
-- Patched RPCs:
--   1. process_payment_atomic  -> 'payment.process' / entity_type 'payment'
--   2. process_refund          -> 'payment.refund'  / entity_type 'payment'
--   3. close_caja_session      -> 'caja.close'      / entity_type 'caja_session'
--   4. add_combo_to_tab        -> 'combo.add_to_tab'/ entity_type 'order_item'
--
-- Note: caja_open is not implemented as a SECURITY DEFINER RPC (caja sessions
-- are opened via direct INSERT under RLS). When/if a caja_open RPC is added,
-- a follow-up migration will wire 'caja.open' there.
--
-- All action labels match constants in src/shared/lib/audit-actions.ts
-- (AuditActionSchema.options).
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. process_payment_atomic — wire 'payment.process'
--    Source: 20260429000000_process_payment_close_when_fully_paid.sql
-- -----------------------------------------------------------------------
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
  v_payment_row jsonb;
BEGIN
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
    tab_id,
    amount,
    tip_amount,
    method,
    processed_by,
    square_payment_id,
    square_receipt_url,
    tendered_amount,
    reference_number,
    idempotency_key,
    discount_scope,
    discount_type,
    discount_value,
    discount_amount
  ) VALUES (
    p_tab_id,
    ROUND(p_amount, 2),
    ROUND(p_tip_amount, 2),
    v_method,
    p_staff_id,
    NULL,
    NULL,
    CASE WHEN p_method = 'cash' THEN ROUND(p_tendered_amount, 2) ELSE NULL END,
    NULLIF(TRIM(p_reference_number), ''),
    p_idempotency_key,
    p_discount_scope,
    p_discount_type,
    p_discount_value,
    p_discount_amount
  )
  RETURNING id INTO v_payment_id;

  -- Subtotal from line items (excludes priced combo children) — same basis as split_tab_evenly
  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_owed
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id
    AND oi.parent_order_item_id IS NULL;

  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0) INTO v_paid_line
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false;

  -- Close only when the tab's item subtotal is fully covered (multi-pay / split)
  IF v_paid_line + 0.0001 >= v_owed THEN
    UPDATE tabs
    SET
      status = 'paid'::tab_status,
      closed_at = NOW(),
      updated_at = NOW()
    WHERE id = p_tab_id AND status = 'open'::tab_status;

    GET DIAGNOSTICS v_tab_updated = ROW_COUNT;

    IF v_tab_updated = 0 THEN
      DELETE FROM payments WHERE id = v_payment_id;
      RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open or was already closed');
    END IF;
  END IF;

  -- AUDIT: record successful payment (Phase 14-03)
  SELECT to_jsonb(p) INTO v_payment_row FROM payments p WHERE p.id = v_payment_id;
  PERFORM record_audit(
    'payment.process',
    'payment',
    v_payment_id,
    NULL,
    v_payment_row,
    'rpc'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'paymentId', v_payment_id
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id INTO v_existing_id FROM payments WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'paymentId', v_existing_id);
    END IF;
    -- Multiple payments per tab are allowed: do not treat tab_id as idempotent
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'message', 'Duplicate payment');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', 'Payment failed');
END;
$$;

REVOKE ALL ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) TO service_role;

-- -----------------------------------------------------------------------
-- 2. process_refund — wire 'payment.refund'
--    Source: 20260427000005_fix_process_refund_idempotency.sql
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION process_refund(
  p_original_payment_id uuid,
  p_items               jsonb,
  p_reason              text,
  p_manager_pin         text
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
  v_refund_row       jsonb;
BEGIN
  -- 1. Verify caller is manager or admin
  SELECT id INTO v_staff_id FROM profiles
  WHERE id = auth.uid()
    AND role IN ('manager', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

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

  -- 5. Over-refund guard
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

    IF (v_item->>'restock')::boolean THEN
      BEGIN
        PERFORM deplete_for_order_item((v_item->>'order_item_id')::uuid, -1);
      EXCEPTION WHEN undefined_function THEN
        NULL;
      END;
    END IF;
  END LOOP;

  -- 8. Insert negative payment row
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

  -- 9. Legacy audit_log table (kept for backward compat; will be removed in Phase 22)
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
    NULL;
  END;

  -- AUDIT: record refund (Phase 14-03)
  SELECT to_jsonb(r) INTO v_refund_row FROM refunds r WHERE r.id = v_refund_id;
  PERFORM record_audit(
    'payment.refund',
    'payment',
    p_original_payment_id,
    to_jsonb(v_payment),
    v_refund_row,
    'rpc'
  );

  RETURN v_refund_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_refund(uuid, jsonb, text, text) TO authenticated;

-- -----------------------------------------------------------------------
-- 3. close_caja_session — wire 'caja.close'
--    Source: 20260420000002_caja_sessions.sql
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION close_caja_session(
  p_caja_id      UUID,
  p_closed_by    UUID,
  p_closing_cash NUMERIC(12,2),
  p_notes        TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_open_tab_count INT;
  v_caller_role TEXT;
  v_before_row jsonb;
  v_after_row  jsonb;
BEGIN
  -- Permission check
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('manager', 'admin') THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'PERMISSION_DENIED',
      'message', 'Only managers and admins can close the caja.'
    ));
  END IF;

  -- Hard block: no open tabs allowed
  SELECT COUNT(*) INTO v_open_tab_count
  FROM tabs
  WHERE caja_session_id = p_caja_id
    AND status = 'open'
    AND is_deleted = FALSE;

  IF v_open_tab_count > 0 THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'OPEN_TABS_EXIST',
      'message', format(
        'Cannot close the caja: %s tab(s) are still open. Close all tabs before closing the caja.',
        v_open_tab_count
      ),
      'openTabCount', v_open_tab_count
    ));
  END IF;

  -- Capture before state
  SELECT to_jsonb(c) INTO v_before_row FROM caja_sessions c WHERE c.id = p_caja_id;

  -- Perform close
  UPDATE caja_sessions
  SET
    closed_at    = now(),
    closed_by    = p_closed_by,
    closing_cash = p_closing_cash,
    notes        = COALESCE(p_notes, notes),
    status       = 'closed'
  WHERE id = p_caja_id AND status = 'open';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND',
      'message', 'Caja session not found or already closed.'
    ));
  END IF;

  -- AUDIT: record successful caja close (Phase 14-03)
  SELECT to_jsonb(c) INTO v_after_row FROM caja_sessions c WHERE c.id = p_caja_id;
  PERFORM record_audit(
    'caja.close',
    'caja_session',
    p_caja_id,
    v_before_row,
    v_after_row,
    'rpc'
  );

  RETURN json_build_object('ok', true);
END;
$$;

-- -----------------------------------------------------------------------
-- 4. add_combo_to_tab — wire 'combo.add_to_tab'
--    Source: 20260425000005_add_combo_to_tab_rpc.sql
-- -----------------------------------------------------------------------
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
  v_parent_row        jsonb;
  i                   integer;
BEGIN
  v_staff_id := auth.uid();

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

  -- 3. If override: write legacy audit trail
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
        NULL;
    END;
  END IF;

  -- 4. Validate slot_selections array against combo_slots
  v_required_count := 0;
  v_filled_required := 0;

  FOR v_slot IN
    SELECT * FROM combo_slots WHERE combo_product_id = p_combo_product_id ORDER BY sort_order
  LOOP
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

      IF v_qty < v_slot.min_qty OR v_qty > v_slot.max_qty THEN
        RAISE EXCEPTION 'SLOT_MIN_MAX_VIOLATION: Slot % qty % outside range %..%',
          v_slot.id, v_qty, v_slot.min_qty, v_slot.max_qty;
      END IF;

      IF v_slot.slot_type = 'product' THEN
        v_child_product_id := (v_selection->>'childProductId')::uuid;

        IF NOT EXISTS (
          SELECT 1 FROM combo_slot_options
          WHERE combo_slot_id = v_slot.id AND child_product_id = v_child_product_id
        ) THEN
          RAISE EXCEPTION 'INVALID_CHILD: Product % is not a valid option for slot %',
            v_child_product_id, v_slot.id;
        END IF;

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

  -- 5. Determine parent price
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

  -- 7. Insert parent order_item
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
    v_selection := null;
    FOR i IN 0..jsonb_array_length(p_slot_selections) - 1
    LOOP
      IF (p_slot_selections->i->>'slotId')::uuid = v_slot.id THEN
        v_selection := p_slot_selections->i;
        EXIT;
      END IF;
    END LOOP;

    IF v_selection IS NULL THEN
      CONTINUE;
    END IF;

    v_qty := (v_selection->>'qty')::integer;

    IF v_slot.slot_type = 'product' THEN
      v_child_product_id := (v_selection->>'childProductId')::uuid;

      FOR i IN 1..v_qty LOOP
        INSERT INTO order_items (
          order_id, product_id, quantity, unit_price,
          parent_order_item_id, combo_slot_id, created_at
        ) VALUES (
          v_order_id, v_child_product_id, 1, 0,
          v_parent_item_id, v_slot.id, now()
        );
      END LOOP;

    ELSIF v_slot.slot_type = 'pool_time' THEN
      SELECT prepaid_minutes INTO v_qty
      FROM combo_slot_options
      WHERE combo_slot_id = v_slot.id
      LIMIT 1;

      NULL;
    END IF;
  END LOOP;

  -- AUDIT: record combo addition (Phase 14-03)
  SELECT to_jsonb(oi) INTO v_parent_row FROM order_items oi WHERE oi.id = v_parent_item_id;
  PERFORM record_audit(
    'combo.add_to_tab',
    'order_item',
    v_parent_item_id,
    NULL,
    v_parent_row,
    'rpc'
  );

  RETURN v_parent_item_id;
END;
$$;

GRANT EXECUTE ON FUNCTION add_combo_to_tab(uuid, uuid, jsonb, boolean, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- Rolling back this migration is non-trivial: each CREATE OR REPLACE FUNCTION
-- here replaced an earlier definition. To restore the prior bodies, re-apply:
--   - 20260429000000_process_payment_close_when_fully_paid.sql (process_payment_atomic)
--   - 20260427000005_fix_process_refund_idempotency.sql        (process_refund)
--   - 20260420000002_caja_sessions.sql                          (close_caja_session)
--   - 20260425000005_add_combo_to_tab_rpc.sql                   (add_combo_to_tab)
-- which will overwrite the audit-wired versions and remove the PERFORM record_audit
-- calls. There is no destructive change to roll back beyond replaying those four
-- migration files in order.
-- COMMIT;
-- =============================================================================
