-- Fix process_refund: legacy audit_log insert references a nonexistent
-- staff_id column. The audit_log table (20260428000001_recipes_tables.sql)
-- was created with actor_id, not staff_id — this typo has been present
-- since 20260511000002_rpc_audit_wiring.sql wired this function's audit
-- trail and raises `undefined_column`, which is NOT caught by the existing
-- `EXCEPTION WHEN undefined_table` guard, aborting every refund.
--
-- Full function body copied from 20260511000002_rpc_audit_wiring.sql with
-- only the one column name corrected (staff_id -> actor_id) in step 9.

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
  --    FIX: actor_id, not staff_id (audit_log's actual column name).
  BEGIN
    INSERT INTO audit_log (action, entity_type, entity_id, actor_id, details)
    VALUES (
      'refund',
      'payment',
      p_original_payment_id,
      v_staff_id,
      jsonb_build_object('refund_id', v_refund_id, 'amount', v_refund_total)
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
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
