-- Manager approvals on the override RPCs.
--
-- 1. payments.approved_by: the staff member who approved a discount or
--    override on that payment (NULL when none was needed).
-- 2. resolve_manager_approval: one place that turns a PIN plus, from newer
--    clients, the approver's id into the approving staff member, with the
--    same attempt limit as verify_staff_pin (shared key per caller).
-- 3. The six RPCs that take p_manager_pin gain a trailing p_approver_id,
--    resolve the approver through the helper instead of their own lookup,
--    and name the approver in the rows and audit payloads they write.
--    Old clients that send the PIN alone keep working as long as exactly
--    one eligible staff member holds it. A refused approval is returned,
--    not raised, so the attempt count is kept.
-- 4. process_direct_sale_atomic resolves once and hands the approver to the
--    payment RPC it delegates to through a transaction-local setting.
--
-- Signatures change (a new trailing argument), so each function is dropped
-- and re-created; PostgREST cannot pick between two overloads.

ALTER TABLE public.payments
  ADD COLUMN approved_by uuid REFERENCES public.profiles(id);
COMMENT ON COLUMN public.payments.approved_by IS
  'Staff member who approved the discount or override on this payment; NULL when none was needed.';

-- Resolves the approving staff member for p_action from a PIN and, when the
-- client sends it, the approver's id. Counts every call against
-- caller:<p_caller_id> through pin_attempt_begin (same key as
-- verify_staff_pin) and clears it only on a usable match. Returns
-- {ok:true, approver_id} or {ok:false, code, retry_after} with code LOCKED,
-- INVALID_PIN or AMBIGUOUS_PIN (PIN only and more than one eligible holder).
CREATE FUNCTION public.resolve_manager_approval(p_pin text, p_approver_id uuid, p_action text, p_caller_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key  text;
  v_wait integer;
  v_ids  uuid[];
BEGIN
  IF p_caller_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: authentication required';
  END IF;
  v_key := 'caller:' || p_caller_id::text;

  v_wait := pin_attempt_begin(v_key);
  IF v_wait > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LOCKED', 'retry_after', v_wait);
  END IF;

  SELECT array_agg(p.id ORDER BY p.id) INTO v_ids
  FROM profiles p
  WHERE p.is_active = true
    AND p_pin ~ '^\d{6}$'
    AND p.pin = p_pin
    AND (p_approver_id IS NULL OR p.id = p_approver_id)
    AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = p.role AND rp.action = p_action);

  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_PIN', 'retry_after', pin_attempt_retry_after(v_key));
  END IF;
  IF cardinality(v_ids) > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AMBIGUOUS_PIN', 'retry_after', pin_attempt_retry_after(v_key));
  END IF;

  PERFORM pin_attempt_record(v_key, true);
  RETURN jsonb_build_object('ok', true, 'approver_id', v_ids[1]);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_manager_approval(text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_manager_approval(text, uuid, text, uuid) TO service_role;

DROP FUNCTION public.process_refund(uuid, jsonb, text, text);
CREATE FUNCTION public.process_refund(p_original_payment_id uuid, p_items jsonb, p_reason text, p_manager_pin text, p_approver_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_staff_id         uuid;
  v_payment          record;
  v_already_refunded numeric;
  v_refund_total     numeric;
  v_refund_id        uuid;
  v_item             jsonb;
  v_refund_row       jsonb;
  v_approval jsonb;
BEGIN
  -- 1. Resolve the APPROVING staff member from the entered PIN (and the
  -- approver's id when the client sends it), never from the caller's own
  -- session role. Attempts are limited per caller.
  v_approval := resolve_manager_approval(p_manager_pin, p_approver_id, 'process_refund', auth.uid());
  IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
    RETURN NULL;
  END IF;
  v_staff_id := (v_approval->>'approver_id')::uuid;

  -- 2. Get original payment (must not itself be a refund, and must not
  --    already be voided by a reopen — Phase 23 Pitfall 6)
  SELECT * INTO v_payment FROM payments
  WHERE id = p_original_payment_id
    AND is_refund = false
    AND status IS DISTINCT FROM 'reopened_void';

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
  INSERT INTO payments (tab_id, amount, method, processed_at, processed_by, is_refund, refund_id, idempotency_key)
  VALUES (
    v_payment.tab_id,
    -v_refund_total,
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
  SELECT to_jsonb(r) || jsonb_build_object('approved_by', v_staff_id) INTO v_refund_row FROM refunds r WHERE r.id = v_refund_id;
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
$function$;

REVOKE ALL ON FUNCTION public.process_refund(uuid, jsonb, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_refund(uuid, jsonb, text, text, uuid) TO authenticated, service_role;

DROP FUNCTION public.reopen_tab(uuid, integer, text, text);
CREATE FUNCTION public.reopen_tab(p_tab_id uuid, p_expected_version integer, p_reason text, p_manager_pin text DEFAULT NULL::text, p_approver_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_staff_id uuid;
  v_current int;
  v_status tab_status;
  v_reopen_count int;
  v_last_reopened timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_voided_total numeric;
  v_caja uuid;
  v_terminal text;
  v_concept text;
  v_approval jsonb;
BEGIN
  v_approval := resolve_manager_approval(p_manager_pin, p_approver_id, 'reopen_tab', auth.uid());
  IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
    IF v_approval->>'code' = 'LOCKED' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                'retryAfter', (v_approval->>'retry_after')::integer);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN', 'message', 'manager or admin role required');
  END IF;
  v_staff_id := (v_approval->>'approver_id')::uuid;

  SELECT version, status, reopen_count, last_reopened_at
  INTO v_current, v_status, v_reopen_count, v_last_reopened
  FROM tabs WHERE id = p_tab_id FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_status NOT IN ('closed', 'paid') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'TAB_NOT_REOPENABLE',
      'message', 'Only closed or paid tabs can be reopened'
    );
  END IF;

  IF v_reopen_count >= 2 THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'REOPEN_CAP_EXCEEDED',
      'message', 'This tab has already been reopened twice'
    );
  END IF;

  IF v_last_reopened IS NOT NULL AND NOW() - v_last_reopened > INTERVAL '24 hours' THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'REOPEN_WINDOW_EXPIRED',
      'message', 'Reopen window has expired'
    );
  END IF;

  SELECT to_jsonb(t.*) INTO v_before FROM tabs t WHERE t.id = p_tab_id;

  WITH newly_voided AS (
    UPDATE payments
    SET status = 'reopened_void', updated_at = NOW()
    WHERE tab_id = p_tab_id AND is_refund = false AND status = 'completed'
    RETURNING amount
  )
  SELECT COALESCE(SUM(amount), 0) INTO v_voided_total FROM newly_voided;

  IF v_voided_total <> 0 THEN
    -- Terminal-scoped lookup (this migration's fix): anchor to the terminal
    -- the tab's original caja session belongs to, so the reversal lands in
    -- the same cash drawer the sale did — not an arbitrary other terminal's
    -- open session.
    SELECT cs.terminal_id INTO v_terminal
    FROM tabs t JOIN caja_sessions cs ON cs.id = t.caja_session_id
    WHERE t.id = p_tab_id;

    IF v_terminal IS NOT NULL THEN
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' AND terminal_id = v_terminal LIMIT 1;
    ELSE
      -- No resolvable original terminal (legacy tab with no caja_session_id)
      -- — fall back to the pre-per-terminal-caja behavior.
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' LIMIT 1;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPEN_CAJA: an open caja session is required to record a reopen adjustment'
        USING ERRCODE = 'P0A02';
    END IF;

    v_concept := left(
      format(
        'Reopen tab %s: %s',
        substr(p_tab_id::text, 1, 8),
        regexp_replace(COALESCE(NULLIF(TRIM(p_reason), ''), 'no reason given'), '[,.()]', '', 'g')
      ),
      200
    );

    INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id)
    VALUES (v_caja, 'expense', v_voided_total, v_concept, v_staff_id);
  END IF;

  UPDATE tabs
  SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1,
      last_reopened_at = NOW(), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  SELECT to_jsonb(t.*) || jsonb_build_object('reason', p_reason, 'approved_by', v_staff_id)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  PERFORM record_audit('tab.reopen', 'tab', p_tab_id, v_before, v_after, 'rpc');

  RETURN jsonb_build_object('ok', true, 'voidedPaymentTotal', v_voided_total);

EXCEPTION
  WHEN sqlstate 'P0V01' THEN
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    RAISE;
  WHEN sqlstate 'P0A01' THEN
    RAISE;
  WHEN sqlstate 'P0A02' THEN
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.reopen_tab(uuid, integer, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_tab(uuid, integer, text, text, uuid) TO authenticated, service_role;

DROP FUNCTION public.edit_paid_tab(uuid, integer, jsonb, text, text, text);
CREATE FUNCTION public.edit_paid_tab(p_tab_id uuid, p_expected_version integer, p_order_item_patches jsonb, p_notes text, p_reason text, p_manager_pin text DEFAULT NULL::text, p_approver_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_staff_id uuid;
  v_current int;
  v_status tab_status;
  v_before jsonb;
  v_after jsonb;
  v_old_total numeric;
  v_new_total numeric;
  v_delta numeric;
  v_caja uuid;
  v_terminal text;
  v_concept text;
  v_sanitized_reason text;
  v_short_id text;
  v_orig_date text;
  v_last_order_id uuid;
  v_patch jsonb;
  v_op text;
  v_item_product_id uuid;
  v_old_qty int;
  v_new_qty int;
  v_qty_delta int;
  v_approval jsonb;
BEGIN
  v_approval := resolve_manager_approval(p_manager_pin, p_approver_id, 'edit_paid_tab', auth.uid());
  IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
    IF v_approval->>'code' = 'LOCKED' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                'retryAfter', (v_approval->>'retry_after')::integer);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN', 'message', 'manager or admin role required');
  END IF;
  v_staff_id := (v_approval->>'approver_id')::uuid;

  SELECT version, status INTO v_current, v_status
  FROM tabs WHERE id = p_tab_id FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_status NOT IN ('paid', 'closed') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'TAB_NOT_EDITABLE',
      'message', 'Only paid or closed tabs can be edited'
    );
  END IF;

  SELECT to_jsonb(t.*) || jsonb_build_object(
    'items', (
      SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tab_id = p_tab_id AND oi.is_deleted = false
    )
  )
  INTO v_before
  FROM tabs t WHERE t.id = p_tab_id;

  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_old_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false;

  SELECT o.id INTO v_last_order_id
  FROM orders o WHERE o.tab_id = p_tab_id
  ORDER BY o.created_at DESC LIMIT 1;

  FOR v_patch IN SELECT * FROM jsonb_array_elements(COALESCE(p_order_item_patches, '[]'::jsonb))
  LOOP
    v_op := v_patch->>'op';

    IF v_op = 'update' THEN
      SELECT product_id, quantity INTO v_item_product_id, v_old_qty
      FROM order_items
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id);

      UPDATE order_items
      SET
        quantity = COALESCE((v_patch->>'quantity')::int, quantity),
        unit_price = COALESCE((v_patch->>'unit_price')::numeric, unit_price),
        notes = COALESCE(v_patch->>'notes', notes),
        updated_at = NOW()
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id)
      RETURNING quantity INTO v_new_qty;

      IF v_item_product_id IS NOT NULL AND v_new_qty IS NOT NULL AND v_new_qty <> v_old_qty THEN
        v_qty_delta := v_new_qty - v_old_qty;

        UPDATE inventory
        SET quantity_on_hand = quantity_on_hand - v_qty_delta, updated_at = NOW()
        WHERE product_id = v_item_product_id;

        INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
        VALUES (v_item_product_id, -v_qty_delta, 'correction', v_staff_id, 'order_item', (v_patch->>'id')::uuid);
      END IF;

    ELSIF v_op = 'delete' THEN
      UPDATE order_items
      SET is_deleted = true, deleted_at = NOW()
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id)
      RETURNING product_id, quantity INTO v_item_product_id, v_old_qty;

      IF v_item_product_id IS NOT NULL THEN
        UPDATE inventory
        SET quantity_on_hand = quantity_on_hand + v_old_qty, updated_at = NOW()
        WHERE product_id = v_item_product_id;

        INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
        VALUES (v_item_product_id, v_old_qty, 'correction', v_staff_id, 'order_item', (v_patch->>'id')::uuid);
      END IF;

    ELSIF v_op = 'add' THEN
      IF v_last_order_id IS NULL THEN
        RAISE EXCEPTION 'NO_ORDER_FOUND: tab % has no orders to attach a new item to', p_tab_id;
      END IF;
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, notes)
      VALUES (
        v_last_order_id,
        (v_patch->>'product_id')::uuid,
        COALESCE((v_patch->>'quantity')::int, 1),
        (v_patch->>'unit_price')::numeric,
        NULLIF(v_patch->>'notes', '')
      );
    END IF;
  END LOOP;

  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_new_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false;

  v_delta := v_new_total - v_old_total;

  IF v_delta <> 0 THEN
    -- Terminal-scoped lookup (this migration's fix) — see reopen_tab above.
    SELECT cs.terminal_id INTO v_terminal
    FROM tabs t JOIN caja_sessions cs ON cs.id = t.caja_session_id
    WHERE t.id = p_tab_id;

    IF v_terminal IS NOT NULL THEN
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' AND terminal_id = v_terminal LIMIT 1;
    ELSE
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' LIMIT 1;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPEN_CAJA: an open caja session is required to record a total-changing edit'
        USING ERRCODE = 'P0A02';
    END IF;

    SELECT substr(t.id::text, 1, 8), to_char(t.opened_at, 'YYYY-MM-DD')
    INTO v_short_id, v_orig_date
    FROM tabs t WHERE t.id = p_tab_id;

    v_sanitized_reason := regexp_replace(COALESCE(NULLIF(TRIM(p_reason), ''), 'no reason given'), '[,.()]', '', 'g');

    v_concept := left(
      format('Edit paid tab %s (%s): %s', v_short_id, v_orig_date, v_sanitized_reason),
      200
    );

    INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id)
    VALUES (
      v_caja,
      CASE WHEN v_delta > 0 THEN 'income' ELSE 'expense' END,
      abs(v_delta),
      v_concept,
      v_staff_id
    );
  END IF;

  UPDATE tabs
  SET notes = COALESCE(p_notes, notes), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  SELECT to_jsonb(t.*) || jsonb_build_object(
    'items', (
      SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tab_id = p_tab_id AND oi.is_deleted = false
    )
  ) || jsonb_build_object('reason', p_reason, 'approved_by', v_staff_id)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  PERFORM record_audit('tab.edit_paid', 'tab', p_tab_id, v_before, v_after, 'rpc');

  RETURN jsonb_build_object(
    'ok', true,
    'newTotal', v_new_total,
    'delta', v_delta,
    'cajaAdjustmentRecorded', v_delta <> 0
  );

EXCEPTION
  WHEN sqlstate 'P0V01' THEN
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    RAISE;
  WHEN sqlstate 'P0A01' THEN
    RAISE;
  WHEN sqlstate 'P0A02' THEN
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.edit_paid_tab(uuid, integer, jsonb, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_paid_tab(uuid, integer, jsonb, text, text, text, uuid) TO authenticated, service_role;

DROP FUNCTION public.process_payment_atomic(uuid, uuid, numeric, text, text, numeric, text, text, text, text, numeric, numeric, integer, text, boolean, text);
CREATE FUNCTION public.process_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_amount numeric, p_method text, p_idempotency_key text, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_rappi_order_id text DEFAULT NULL::text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer, p_customer_phone text DEFAULT NULL::text, p_manager_override boolean DEFAULT false, p_manager_pin text DEFAULT NULL::text, p_approver_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_id UUID;
  v_existing_tab UUID;
  v_tab_status tab_status;
  v_total NUMERIC;
  v_payment_id UUID;
  v_method payment_method;
  v_tab_updated INT;
  v_owed NUMERIC;
  v_paid_line NUMERIC;
  v_discount_recorded NUMERIC;
  v_payment_row jsonb;
  v_current INT;
  v_transfer_code TEXT;
  -- Phase 27 Plan 09 (G-27-13): resolved from p_manager_pin, independent of p_staff_id.
  v_manager_staff_id uuid;
  v_approval jsonb;
BEGIN
  -- Phase 27 gap-closure code review (CR-01/CR-02): coalesce a stray SQL NULL
  -- to false so a caller that omits the parameter (or passes NULL explicitly,
  -- overriding the DEFAULT) can never silently skip both the 'IF
  -- p_manager_override' PIN-verification branch AND the 'IF NOT
  -- p_manager_override' DISCOUNT_REQUIRES_MANAGER guard below -- NULL is
  -- neither TRUE nor FALSE in PL/pgSQL, so both branches would otherwise be
  -- skipped. Defense-in-depth: all three RPCs grant EXECUTE to 'authenticated',
  -- so a caller can invoke them directly via PostgREST, bypassing the edge
  -- function's own '?? false' coalesce entirely.
  p_manager_override := COALESCE(p_manager_override, false);

  -- Configurable payment methods: rappi/uber_eats are platform tenders,
  -- treated exactly like card below (no tendered amount, no order-id match).
  IF p_method NOT IN ('cash', 'card', 'rappi', 'uber_eats', 'bank_transfer') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Payment method must be cash, card, rappi, uber_eats, or bank_transfer');
  END IF;

  v_method := p_method::payment_method;

  -- WR-03 fix (23-REVIEW.md): "checkout-time only" (D-16) was enforced only
  -- client-side (PaymentForm omits the bank-transfer processor). Any staff
  -- member with an active shift could otherwise reach this RPC directly via
  -- PostgREST with their own JWT and mark bank_transfer on an arbitrary
  -- pre-existing tab. Two trusted paths are allowed through:
  --   1. app.bank_transfer_checkout_context — a transaction-local GUC
  --      (is_local=true, resets at transaction end) set only by
  --      process_direct_sale_atomic right before it calls this function for
  --      its own freshly-inserted tab. It is NOT an RPC parameter, so a
  --      regular-JWT PostgREST caller cannot spoof it.
  --   2. auth.role() = 'service_role' — server-side/service-key callers
  --      (integration tests, future edge functions) are already trusted with
  --      full RLS bypass; this mirrors that trust level rather than adding a
  --      new distinct one.
  -- A regular authenticated staff JWT satisfies neither, so the direct-call
  -- exploit path the reviewer flagged is closed.
  IF p_method = 'bank_transfer'
     AND current_setting('app.bank_transfer_checkout_context', true) IS DISTINCT FROM 'true'
     AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Bank transfer payments can only be marked at checkout time');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_staff_id AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Staff not found or inactive');
  END IF;

  -- Whenever a manager override is claimed, resolve the APPROVING staff
  -- member from the entered PIN (and the approver's id when the client sends
  -- it), never from the caller's own p_staff_id. When process_direct_sale_atomic
  -- delegates here it has already resolved the approver and hands it down
  -- through a transaction-local setting, so it is not checked twice.
  IF p_manager_override THEN
    v_manager_staff_id := NULLIF(current_setting('app.manager_approver_id', true), '')::uuid;
    IF v_manager_staff_id IS NULL THEN
      v_approval := resolve_manager_approval(p_manager_pin, p_approver_id, 'apply_custom_discount', p_staff_id);
      IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
        IF v_approval->>'code' = 'LOCKED' THEN
          RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                    'retryAfter', (v_approval->>'retry_after')::integer);
        END IF;
        RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Not authorized to apply a manager override');
      END IF;
      v_manager_staff_id := (v_approval->>'approver_id')::uuid;
    END IF;
  END IF;

  -- Phase 27 Plan 09 (G-27-13): before this migration, any discount field
  -- could be set with ZERO authorization check (T-27-12) — a cashier's own
  -- JWT could record an arbitrary discount via a raw PostgREST call.
  IF p_discount_scope IS NOT NULL OR p_discount_type IS NOT NULL
     OR p_discount_value IS NOT NULL OR p_discount_amount IS NOT NULL THEN
    IF NOT p_manager_override THEN
      RETURN jsonb_build_object('ok', false, 'code', 'DISCOUNT_REQUIRES_MANAGER', 'message', 'Ad-hoc discount requires manager authorization');
    END IF;
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

  -- Phase 15: lock tab row + assert expected_version (canonical guard).
  -- Configurable payment methods: no longer needs tabs.rappi_order_id (the
  -- Rappi/uber_eats order-id match guard below is removed).
  SELECT status, version
  INTO v_tab_status, v_current
  FROM tabs
  WHERE id = p_tab_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_tab_status IS DISTINCT FROM 'open'::tab_status THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open');
  END IF;

  v_total := ROUND(p_amount, 2);

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

  IF p_method = 'bank_transfer' THEN
    v_transfer_code := bank_transfer_generate_unique_code();
  END IF;

  INSERT INTO payments (
    tab_id,
    amount,
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
    discount_amount,
    approved_by
  ) VALUES (
    p_tab_id,
    ROUND(p_amount, 2),
    v_method,
    p_staff_id,
    NULL,
    NULL,
    CASE WHEN p_method = 'cash' THEN ROUND(p_tendered_amount, 2) ELSE NULL END,
    CASE WHEN p_method = 'bank_transfer' THEN v_transfer_code ELSE NULLIF(TRIM(p_reference_number), '') END,
    p_idempotency_key,
    p_discount_scope,
    p_discount_type,
    p_discount_value,
    p_discount_amount,
    v_manager_staff_id
  )
  RETURNING id INTO v_payment_id;

  -- Subtotal from line items (excludes priced combo children) — same basis as split_tab_evenly
  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_owed
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id
    AND oi.parent_order_item_id IS NULL;

  -- Phase 23: exclude reopened_void rows (voided by reopen_tab) from the
  -- "already paid" sum so a reopened-then-repaid tab is not double-counted.
  -- Phase 27: also sum any ad-hoc discount already recorded on the tab's
  -- payments — order_items.unit_price never reflects an ad-hoc discount
  -- (only a promotion discount, baked in at insert time), so "fully covered"
  -- must mean paid + discount >= the raw item subtotal.
  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0), COALESCE(ROUND(SUM(p.discount_amount), 2), 0)
    INTO v_paid_line, v_discount_recorded
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false
    AND p.status IS DISTINCT FROM 'reopened_void';

  -- Close only when the tab's item subtotal is fully covered (multi-pay / split).
  -- Phase 15: bump tabs.version on close. The bump_version_on_update trigger
  -- enforces +1 advancement.
  IF v_paid_line + v_discount_recorded + 0.0001 >= v_owed THEN
    UPDATE tabs
    SET
      status = 'paid'::tab_status,
      closed_at = NOW(),
      updated_at = NOW(),
      version = version + 1
    WHERE id = p_tab_id AND status = 'open'::tab_status;

    GET DIAGNOSTICS v_tab_updated = ROW_COUNT;

    IF v_tab_updated = 0 THEN
      DELETE FROM payments WHERE id = v_payment_id;
      RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open or was already closed');
    END IF;
  ELSE
    -- Partial payment path: still advance version so concurrent partial-pay
    -- attempts using the same expected_version are rejected by the next call's
    -- guard. No status change.
    UPDATE tabs
    SET
      updated_at = NOW(),
      version = version + 1
    WHERE id = p_tab_id;
  END IF;

  -- Phase 23-01: mark-pending bank-transfer bookkeeping — a pending
  -- bank_transfers row + its own audit entry, in the same transaction as the
  -- payment row (D-09). No auto-confirm path exists anywhere (D-06):
  -- confirm_transfer_payment/dispute_transfer_payment are the only functions
  -- that ever change this row's status, and both require an explicit
  -- manager+ argument.
  IF p_method = 'bank_transfer' THEN
    INSERT INTO bank_transfers (payment_id, customer_phone, created_by)
    VALUES (v_payment_id, NULLIF(TRIM(p_customer_phone), ''), p_staff_id);

    PERFORM record_audit(
      'payment.transfer_marked_pending',
      'payment',
      v_payment_id,
      NULL,
      jsonb_build_object('referenceCode', v_transfer_code, 'amount', v_total, 'customerPhone', p_customer_phone),
      'rpc'
    );
  END IF;

  -- AUDIT: record successful payment (Phase 14-03; preserved). Sits AFTER the
  -- version guard so on P0V01/P0V02 the raise fires first and audit is skipped.
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
  WHEN sqlstate 'P0V01' THEN
    -- Re-raise STALE_VERSION so the caller (PostgREST) propagates the SQLSTATE
    -- to the client; do NOT swallow into the generic 'ok=false' shape.
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    -- Re-raise NOT_FOUND_VERSIONED for the same reason.
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', 'Payment failed');
END;
$function$;

REVOKE ALL ON FUNCTION public.process_payment_atomic(uuid, uuid, numeric, text, text, numeric, text, text, text, text, numeric, numeric, integer, text, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_payment_atomic(uuid, uuid, numeric, text, text, numeric, text, text, text, text, numeric, numeric, integer, text, boolean, text, uuid) TO service_role;

DROP FUNCTION public.process_split_payment_atomic(uuid, uuid, jsonb, numeric, text, text, text, numeric, numeric, integer, boolean, text);
CREATE FUNCTION public.process_split_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_legs jsonb, p_expected_total numeric, p_idempotency_key text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer, p_manager_override boolean DEFAULT false, p_manager_pin text DEFAULT NULL::text, p_approver_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_leg_count       INT;
  v_existing_id     UUID;
  v_existing_group  UUID;
  v_payment_ids     UUID[];
  v_tab_status      tab_status;
  v_current         INT;
  v_legs_sum        NUMERIC;
  v_group_id        UUID;
  v_i               INT;
  v_leg             JSONB;
  v_method          TEXT;
  v_leg_amount      NUMERIC;
  v_leg_tendered    NUMERIC;
  v_leg_ref         TEXT;
  v_payment_id      UUID;
  v_owed            NUMERIC;
  v_paid_line       NUMERIC;
  v_discount_recorded NUMERIC;
  v_tab_updated     INT;
  -- Phase 27 Plan 09 (G-27-13): resolved from p_manager_pin, independent of p_staff_id.
  v_manager_staff_id uuid;
  v_approval jsonb;
BEGIN
  -- Phase 27 gap-closure code review (CR-01/CR-02): coalesce a stray SQL NULL
  -- to false so a caller that omits the parameter (or passes NULL explicitly,
  -- overriding the DEFAULT) can never silently skip both the 'IF
  -- p_manager_override' PIN-verification branch AND the 'IF NOT
  -- p_manager_override' DISCOUNT_REQUIRES_MANAGER guard below -- NULL is
  -- neither TRUE nor FALSE in PL/pgSQL, so both branches would otherwise be
  -- skipped. Defense-in-depth: all three RPCs grant EXECUTE to 'authenticated',
  -- so a caller can invoke them directly via PostgREST, bypassing the edge
  -- function's own '?? false' coalesce entirely.
  p_manager_override := COALESCE(p_manager_override, false);

  -- 1. FORBIDDEN guard
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_staff_id AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Staff not found or inactive');
  END IF;

  -- Whenever a manager override is claimed, resolve the APPROVING staff
  -- member from the entered PIN (and the approver's id when the client sends
  -- it), never from the caller's own p_staff_id. When process_direct_sale_atomic
  -- delegates here it has already resolved the approver and hands it down
  -- through a transaction-local setting, so it is not checked twice.
  IF p_manager_override THEN
    v_manager_staff_id := NULLIF(current_setting('app.manager_approver_id', true), '')::uuid;
    IF v_manager_staff_id IS NULL THEN
      v_approval := resolve_manager_approval(p_manager_pin, p_approver_id, 'apply_custom_discount', p_staff_id);
      IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
        IF v_approval->>'code' = 'LOCKED' THEN
          RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                    'retryAfter', (v_approval->>'retry_after')::integer);
        END IF;
        RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Not authorized to apply a manager override');
      END IF;
      v_manager_staff_id := (v_approval->>'approver_id')::uuid;
    END IF;
  END IF;

  -- Phase 27 Plan 09 (G-27-13): before this migration, any discount field
  -- could be set with ZERO authorization check (T-27-12) — a cashier's own
  -- JWT could record an arbitrary discount via a raw PostgREST call.
  IF p_discount_scope IS NOT NULL OR p_discount_type IS NOT NULL
     OR p_discount_value IS NOT NULL OR p_discount_amount IS NOT NULL THEN
    IF NOT p_manager_override THEN
      RETURN jsonb_build_object('ok', false, 'code', 'DISCOUNT_REQUIRES_MANAGER', 'message', 'Ad-hoc discount requires manager authorization');
    END IF;
  END IF;

  -- 2. Leg-count validation (D-02: up to 4 rows total)
  v_leg_count := jsonb_array_length(p_legs);
  IF v_leg_count < 1 OR v_leg_count > 4 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'TOO_MANY_LEGS',
      'message', format('Split payment must have between 1 and 4 legs, got %s', v_leg_count)
    );
  END IF;

  -- 3. Idempotency replay (Pattern 3 — per-leg derived keys, -leg0 sentinel)
  SELECT id, payment_group_id INTO v_existing_id, v_existing_group
  FROM payments
  WHERE idempotency_key = p_idempotency_key || '-leg0'
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    SELECT array_agg(id ORDER BY split_index) INTO v_payment_ids
    FROM payments
    WHERE payment_group_id = v_existing_group;

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'paymentGroupId', v_existing_group,
      'paymentIds', to_jsonb(v_payment_ids)
    );
  END IF;

  -- 4. Version guard — copied verbatim from process_payment_atomic
  --    (20260512000002_rpc_versioned_group_a.sql lines 103-119).
  -- Configurable payment methods: no longer needs tabs.rappi_order_id (the
  -- per-leg Rappi/uber_eats order-id match guard below is removed).
  SELECT status, version
  INTO v_tab_status, v_current
  FROM tabs
  WHERE id = p_tab_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_tab_status IS DISTINCT FROM 'open'::tab_status THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open');
  END IF;

  -- 5. Sum validation (D-05) — server-side authoritative check
  SELECT COALESCE(SUM((leg->>'amount')::numeric), 0) INTO v_legs_sum
  FROM jsonb_array_elements(p_legs) AS leg;

  IF ABS(v_legs_sum - p_expected_total) > 0.01 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'SPLIT_TOTAL_MISMATCH',
      'message', format('Split legs sum %s does not match expected total %s (+/-0.01 allowed)', v_legs_sum, p_expected_total)
    );
  END IF;

  v_group_id := gen_random_uuid();
  v_payment_ids := '{}';

  -- 8. Per-leg loop — insert 1-4 payment rows sharing v_group_id
  FOR v_i IN 0..(v_leg_count - 1) LOOP
    v_leg := p_legs->v_i;
    v_method       := v_leg->>'method';
    v_leg_amount   := (v_leg->>'amount')::numeric;
    v_leg_tendered := (v_leg->>'tenderedAmount')::numeric;
    v_leg_ref      := v_leg->>'referenceNumber';

    -- Configurable payment methods: rappi/uber_eats are platform tenders,
    -- treated exactly like card below (no tendered amount, no order-id match).
    IF v_method NOT IN ('cash', 'card', 'rappi', 'uber_eats') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Payment method must be cash, card, rappi, or uber_eats');
    END IF;

    -- Pitfall 3: pre-empt the amount_positive CHECK constraint with a
    -- descriptive per-leg error before the INSERT ever fires.
    IF v_leg_amount IS NULL OR v_leg_amount <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'EMPTY_LEG', 'message', format('Leg %s has amount <= 0', v_i));
    END IF;

    IF v_method = 'cash' THEN
      IF v_leg_tendered IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_REQUIRED', 'message', 'Tendered amount required for cash leg');
      END IF;
      IF ROUND(v_leg_tendered, 2) < ROUND(v_leg_amount, 2) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_TENDER', 'message', 'Tendered amount is less than leg total');
      END IF;
    ELSE
      IF v_leg_tendered IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_NOT_ALLOWED', 'message', 'Tendered amount is only for cash payments');
      END IF;
    END IF;

    -- Discount stored ONLY on split_index=0 (D-04: discount computed once on
    -- the full tab, not per row — avoids double-count in SUM(discount_amount)
    -- reports).
    INSERT INTO payments (
      tab_id,
      amount,
      method,
      processed_by,
      tendered_amount,
      reference_number,
      idempotency_key,
      payment_group_id,
      split_index,
      discount_scope,
      discount_type,
      discount_value,
      discount_amount,
      approved_by
    ) VALUES (
      p_tab_id,
      ROUND(v_leg_amount, 2),
      v_method::payment_method,
      p_staff_id,
      CASE WHEN v_method = 'cash' THEN ROUND(v_leg_tendered, 2) ELSE NULL END,
      NULLIF(TRIM(v_leg_ref), ''),
      p_idempotency_key || '-leg' || v_i::text,
      v_group_id,
      v_i,
      CASE WHEN v_i = 0 THEN p_discount_scope ELSE NULL END,
      CASE WHEN v_i = 0 THEN p_discount_type ELSE NULL END,
      CASE WHEN v_i = 0 THEN p_discount_value ELSE NULL END,
      CASE WHEN v_i = 0 THEN p_discount_amount ELSE NULL END,
      v_manager_staff_id
    )
    RETURNING id INTO v_payment_id;

    v_payment_ids := v_payment_ids || v_payment_id;
  END LOOP;

  -- 9. Tab-close — copied verbatim from process_payment_atomic
  --    (20260512000002_rpc_versioned_group_a.sql lines 184-222), adapted to
  --    delete ALL group legs (not a single row) on the close-race.
  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_owed
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id
    AND oi.parent_order_item_id IS NULL;

  -- Phase 23: exclude reopened_void rows (voided by reopen_tab) from the
  -- "already paid" sum so a reopened-then-repaid tab is not double-counted.
  -- Phase 27: also sum any ad-hoc discount already recorded on the tab's
  -- payments — see process_payment_atomic's matching comment above for the
  -- full rationale.
  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0), COALESCE(ROUND(SUM(p.discount_amount), 2), 0)
    INTO v_paid_line, v_discount_recorded
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false
    AND p.status IS DISTINCT FROM 'reopened_void';

  IF v_paid_line + v_discount_recorded + 0.0001 >= v_owed THEN
    UPDATE tabs
    SET
      status = 'paid'::tab_status,
      closed_at = NOW(),
      updated_at = NOW(),
      version = version + 1
    WHERE id = p_tab_id AND status = 'open'::tab_status;

    GET DIAGNOSTICS v_tab_updated = ROW_COUNT;

    IF v_tab_updated = 0 THEN
      DELETE FROM payments WHERE payment_group_id = v_group_id;
      RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN', 'message', 'Tab is not open or was already closed');
    END IF;
  ELSE
    -- Partial payment path: still advance version so concurrent partial-pay
    -- attempts using the same expected_version are rejected by the next call's
    -- guard. No status change.
    UPDATE tabs
    SET
      updated_at = NOW(),
      version = version + 1
    WHERE id = p_tab_id;
  END IF;

  -- 10. Audit
  PERFORM record_audit(
    'payment.process_split',
    'payment',
    v_group_id,
    NULL,
    jsonb_build_object('paymentIds', to_jsonb(v_payment_ids), 'legCount', v_leg_count, 'approved_by', v_manager_staff_id),
    'rpc'
  );

  -- 11. Return
  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'paymentGroupId', v_group_id,
    'paymentIds', to_jsonb(v_payment_ids)
  );

EXCEPTION
  WHEN unique_violation THEN
    SELECT id, payment_group_id INTO v_existing_id, v_existing_group
    FROM payments
    WHERE idempotency_key = p_idempotency_key || '-leg0'
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT array_agg(id ORDER BY split_index) INTO v_payment_ids
      FROM payments
      WHERE payment_group_id = v_existing_group;

      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'paymentGroupId', v_existing_group,
        'paymentIds', to_jsonb(v_payment_ids)
      );
    END IF;

    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'message', 'Duplicate split payment');
  WHEN sqlstate 'P0V01' THEN
    -- Re-raise STALE_VERSION so the caller (PostgREST) propagates the SQLSTATE
    -- to the client; do NOT swallow into the generic 'ok=false' shape.
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    -- Re-raise NOT_FOUND_VERSIONED for the same reason.
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', 'Split payment failed');
END;
$function$;

REVOKE ALL ON FUNCTION public.process_split_payment_atomic(uuid, uuid, jsonb, numeric, text, text, text, numeric, numeric, integer, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_split_payment_atomic(uuid, uuid, jsonb, numeric, text, text, text, numeric, numeric, integer, boolean, text, uuid) TO service_role;

DROP FUNCTION public.process_direct_sale_atomic(uuid, uuid, uuid, jsonb, text, text, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text, text, boolean, text, text);
CREATE FUNCTION public.process_direct_sale_atomic(p_staff_id uuid, p_shift_id uuid, p_caja_session_id uuid, p_items jsonb, p_idempotency_key text, p_method text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_legs jsonb DEFAULT NULL::jsonb, p_expected_total numeric DEFAULT NULL::numeric, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_customer_name text DEFAULT 'Walk-in'::text, p_customer_phone text DEFAULT NULL::text, p_manager_override boolean DEFAULT false, p_manager_pin text DEFAULT NULL::text, p_terminal_id text DEFAULT NULL::text, p_approver_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_payment_id uuid; v_existing_tab_id uuid; v_existing_group_id uuid; v_existing_payment_ids uuid[];
  v_existing_staff_id uuid; v_existing_shift_id uuid; v_existing_caja_id uuid;
  v_catalog_price numeric; v_expected_price numeric; v_sold_by_weight boolean; v_weight_grams integer;
  v_cost_price numeric; v_elem jsonb; v_tab_id uuid; v_order_id uuid; v_result jsonb;
  v_modifier_ids uuid[]; v_modifier_delta numeric; v_line_qty int;
  v_subtotal numeric := 0; v_tax_rate numeric; v_tax numeric; v_derived_total numeric;
  v_tax_inclusive boolean;
  v_derived_items jsonb := '[]'::jsonb;
  -- Phase 27: promotions + floor guard.
  v_category_id uuid;
  v_expiry_date date;
  v_near_expiry_threshold int;
  v_near_expiry_discount_pct numeric;
  v_cand_id uuid; v_cand_rate numeric; v_cand_created_at timestamptz; v_cand_amount numeric;
  v_expiry_amount numeric;
  v_promo_id uuid; v_promo_rate numeric;
  v_line_discount numeric;
  v_line_price numeric;
  v_adhoc_discount numeric;
  -- Phase 27 Plan 08 (G-27-13): resolved from p_manager_pin, independent of p_staff_id.
  v_manager_staff_id uuid;
  -- Phase 28 (D-06): store-local timezone for the recurrence AND-filter below.
  v_store_tz text;
  -- Caja-per-terminal: the open caja's own terminal_id, for the mismatch guard below.
  v_caja_terminal text;
  -- Task 4: combo pass (spec A.4/A.6).
  v_combo record; v_slot record; v_app_units int[]; v_gross numeric; v_net numeric;
  v_best_net numeric; v_best_combo_id uuid; v_best_units int[]; v_best_gross numeric;
  v_best_type text; v_best_value numeric; v_iter int := 0; v_sum numeric; v_alloc numeric;
  v_running numeric; v_idx int; v_n int;
  v_residual numeric; v_unit_price numeric; v_unit_discount numeric;
  v_before jsonb; v_grp record;
  -- Review fix (round 1, Critical): dedicated per-slot scratch array, kept
  -- strictly separate from v_best_units (the WINNING application's units,
  -- written only inside the `IF v_gross > 0 AND v_net > v_best_net` branch).
  -- v_best_units used to double as this scratch during every slot-fill of
  -- EVERY candidate combo, so after the FOR v_combo loop it held whichever
  -- candidate's last slot was evaluated last, not necessarily the winner's.
  v_slot_units int[];
  -- Review fix (round 1, Important #2): per-application counter so the
  -- below-cost floor guard can be checked once per whole combo application
  -- (Σrevenue vs Σcost across every unit it consumed), not per resulting row.
  v_app_no int := 0;
  v_approval jsonb;
BEGIN
  -- Phase 27 gap-closure code review (CR-01/CR-02): coalesce a stray SQL NULL
  -- to false so a caller that omits the parameter (or passes NULL explicitly,
  -- overriding the DEFAULT) can never silently skip both the 'IF
  -- p_manager_override' PIN-verification branch AND the 'IF NOT
  -- p_manager_override' DISCOUNT_REQUIRES_MANAGER guard below -- NULL is
  -- neither TRUE nor FALSE in PL/pgSQL, so both branches would otherwise be
  -- skipped. Defense-in-depth: all three RPCs grant EXECUTE to 'authenticated',
  -- so a caller can invoke them directly via PostgREST, bypassing the edge
  -- function's own '?? false' coalesce entirely.
  p_manager_override := COALESCE(p_manager_override, false);

  SELECT terminal_id INTO v_caja_terminal FROM caja_sessions WHERE id = p_caja_session_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CAJA_CLOSED', 'message', 'Caja session is not open');
  END IF;
  IF p_terminal_id IS NOT NULL AND v_caja_terminal <> p_terminal_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CAJA_CLOSED', 'message', 'Caja session belongs to terminal ' || v_caja_terminal);
  END IF;
  PERFORM 1 FROM shifts WHERE id = p_shift_id AND staff_id = p_staff_id AND clock_out IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SHIFT_NOT_OPEN', 'message', 'Shift is not open or does not belong to this cashier');
  END IF;

  SELECT p.id, p.tab_id, p.payment_group_id, t.staff_id, t.shift_id, t.caja_session_id
  INTO v_existing_payment_id, v_existing_tab_id, v_existing_group_id, v_existing_staff_id, v_existing_shift_id, v_existing_caja_id
  FROM payments p JOIN tabs t ON t.id = p.tab_id
  WHERE p.idempotency_key IN (p_idempotency_key, p_idempotency_key || '-leg0')
  ORDER BY p.processed_at LIMIT 1;
  IF FOUND THEN
    IF v_existing_staff_id IS DISTINCT FROM p_staff_id
       OR v_existing_shift_id IS DISTINCT FROM p_shift_id
       OR v_existing_caja_id IS DISTINCT FROM p_caja_session_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_UNAUTHORIZED', 'message', 'Not authorized to replay this payment');
    END IF;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT array_agg(id ORDER BY split_index) INTO v_existing_payment_ids FROM payments WHERE payment_group_id = v_existing_group_id;
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'tabId', v_existing_tab_id, 'paymentGroupId', v_existing_group_id, 'paymentIds', to_jsonb(v_existing_payment_ids));
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'tabId', v_existing_tab_id, 'paymentId', v_existing_payment_id);
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ITEMS', 'message', 'At least one item is required');
  END IF;
  -- Configurable payment methods: rappi/uber_eats join the single-method
  -- (non-split) path, exactly like cash/card/bank_transfer.
  IF (p_method IN ('cash', 'card', 'bank_transfer', 'rappi', 'uber_eats')) = (p_legs IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Provide one payment method or split legs');
  END IF;

  -- Whenever a manager override is claimed (ad-hoc discount or the
  -- below-cost guard in the per-item loop), resolve the APPROVING staff
  -- member from the entered PIN (and the approver's id when the client sends
  -- it), never from the caller's own p_staff_id. One PIN entry approves the
  -- whole checkout attempt; the approver is handed to the payment RPC below
  -- so it records the same person without a second check.
  IF p_manager_override THEN
    v_approval := resolve_manager_approval(p_manager_pin, p_approver_id, 'apply_custom_discount', p_staff_id);
    IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
      IF v_approval->>'code' = 'LOCKED' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                  'retryAfter', (v_approval->>'retry_after')::integer);
      END IF;
      RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Not authorized to apply a manager override');
    END IF;
    v_manager_staff_id := (v_approval->>'approver_id')::uuid;
    PERFORM set_config('app.manager_approver_id', v_manager_staff_id::text, true);
    -- The payment RPC writes payments.approved_by from the setting.
  END IF;

  IF p_discount_scope IS NOT NULL OR p_discount_type IS NOT NULL
     OR p_discount_value IS NOT NULL OR p_discount_amount IS NOT NULL THEN
    IF NOT p_manager_override THEN
      RETURN jsonb_build_object('ok', false, 'code', 'DISCOUNT_REQUIRES_MANAGER', 'message', 'Ad-hoc discount requires manager authorization');
    END IF;
    IF p_discount_scope IS DISTINCT FROM 'all' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DISCOUNT_SCOPE', 'message', 'discountScope must be all for a direct sale');
    END IF;
    -- WR-05 fix: the four discount params are a single all-or-nothing group
    -- (the client always sends them together, useCheckoutSale.ts:133-141).
    -- A malformed/partial set (e.g. discountScope set but discountValue
    -- NULL) must be rejected here — never allowed to NULL-propagate through
    -- v_adhoc_discount/v_subtotal/v_derived_total, where it would silently
    -- defeat the AMOUNT_MISMATCH guard (`IF NULL THEN` is false, not an
    -- error, in plpgsql).
    IF p_discount_type IS NULL OR p_discount_value IS NULL OR p_discount_amount IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DISCOUNT_PARAMS', 'message', 'discountScope, discountType, discountValue and discountAmount must all be supplied together');
    END IF;
  END IF;

  -- Expiry-proximity trigger config (PROMO-02/D-01..D-04) — reuses the same
  -- settings.near_expiry row the near-expiry alert badge already reads, with
  -- the same double-COALESCE fallback pattern v_tax_inclusive uses below (a
  -- missing settings row leaves both NULL after SELECT INTO).
  SELECT COALESCE((value->>'thresholdDays')::int, 14), COALESCE((value->>'discountPercent')::numeric, 15)
    INTO v_near_expiry_threshold, v_near_expiry_discount_pct FROM settings WHERE key = 'near_expiry';
  v_near_expiry_threshold := COALESCE(v_near_expiry_threshold, 14);
  v_near_expiry_discount_pct := COALESCE(v_near_expiry_discount_pct, 15);

  -- Phase 28 (D-06): store-local timezone for the recurrence AND-filter
  -- below, fetched once per checkout, same double-COALESCE fallback pattern
  -- as v_near_expiry_threshold above.
  SELECT COALESCE((value->>'timezone')::text, 'America/Mexico_City') INTO v_store_tz
  FROM settings WHERE key = 'general';
  v_store_tz := COALESCE(v_store_tz, 'America/Mexico_City');

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    -- Reset every per-item variable at the top of each iteration — plpgsql's
    -- SELECT INTO does NOT null out target variables when zero rows match,
    -- so without this a product/inventory/promotion row missing for THIS
    -- item would silently inherit the PREVIOUS item's values (cost_price,
    -- expiry_date, category_id, promo candidate) — a latent staleness bug
    -- this floor guard and promotion match cannot tolerate.
    v_catalog_price := NULL; v_sold_by_weight := NULL; v_category_id := NULL;
    v_cost_price := NULL; v_expiry_date := NULL;
    v_cand_id := NULL; v_cand_rate := NULL; v_cand_created_at := NULL; v_cand_amount := NULL;
    v_expiry_amount := NULL; v_promo_id := NULL; v_promo_rate := NULL; v_line_discount := 0;

    SELECT base_price, sold_by_weight, category_id INTO v_catalog_price, v_sold_by_weight, v_category_id
    FROM products WHERE id = (v_elem->>'product_id')::uuid AND is_active = true FOR UPDATE;
    IF v_catalog_price IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRICE_MISMATCH', 'message', 'Item price does not match catalog');
    END IF;
    SELECT cost_price, expiry_date INTO v_cost_price, v_expiry_date
    FROM inventory WHERE product_id = (v_elem->>'product_id')::uuid FOR UPDATE;
    v_weight_grams := NULLIF(v_elem->>'weight_grams', '')::integer;
    IF v_weight_grams IS NOT NULL AND (v_weight_grams <= 0 OR v_weight_grams > 50000) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'WEIGHT_OUT_OF_RANGE', 'message', 'Weight must be between 0 and 50kg');
    END IF;
    IF COALESCE(v_sold_by_weight, false) AND v_weight_grams IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'WEIGHT_OUT_OF_RANGE', 'message', 'Weight must be between 0 and 50kg');
    END IF;
    v_expected_price := CASE WHEN COALESCE(v_sold_by_weight, false)
      THEN ROUND(v_catalog_price * (v_weight_grams / 1000.0), 2) ELSE v_catalog_price END;
    IF abs((v_elem->>'unit_price')::numeric - v_expected_price) > 0.01 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRICE_MISMATCH', 'message', 'Item price does not match catalog');
    END IF;

    -- Best-price-wins candidate pool (PROMO-04/D-05, extended Phase 28
    -- D-01/D-02/D-04/D-05/D-06): every active promotion matching this line
    -- item via the junction table (zero target rows = store-wide) AND
    -- passing the recurrence AND-filter is an independent candidate, never
    -- merged/deduped (must_have truth). The single largest discount amount
    -- wins; on an exact tie the most recently created promotion wins (D-06).
    -- Fixed-type is capped at the line's expected price via LEAST;
    -- percent-type is inherently capped since discount_value <= 100 (schema
    -- CHECK). Task 4: restricted to kind='discount' — a combo-kind
    -- promotion is never a per-line candidate, only applied by the combo
    -- pass below.
    SELECT p.id, p.discount_value, p.created_at,
      (CASE WHEN p.discount_type = 'percent'
            THEN ROUND(v_expected_price * p.discount_value / 100.0, 2)
            ELSE LEAST(p.discount_value, v_expected_price)
       END) AS amount
    INTO v_cand_id, v_cand_rate, v_cand_created_at, v_cand_amount
    FROM promotions p
    WHERE p.active
      AND p.kind = 'discount'
      AND now() BETWEEN p.starts_at AND p.ends_at
      AND (
        NOT EXISTS (SELECT 1 FROM promotion_targets pt WHERE pt.promotion_id = p.id)
        OR EXISTS (
          SELECT 1 FROM promotion_targets pt
          WHERE pt.promotion_id = p.id
            AND (pt.product_id = (v_elem->>'product_id')::uuid OR pt.category_id = v_category_id)
        )
      )
      AND (p.days_of_week IS NULL OR EXTRACT(DOW FROM now() AT TIME ZONE v_store_tz)::int = ANY(p.days_of_week))
      AND (p.start_time IS NULL OR (now() AT TIME ZONE v_store_tz)::time BETWEEN p.start_time AND p.end_time)
    ORDER BY amount DESC, p.created_at DESC
    LIMIT 1;

    -- Expiry-proximity auto-discount candidate (PROMO-02) — inclusive cutoff,
    -- same <= comparison useNearExpiryAlerts already uses.
    IF v_expiry_date IS NOT NULL AND v_expiry_date <= (CURRENT_DATE + v_near_expiry_threshold) THEN
      v_expiry_amount := ROUND(v_expected_price * v_near_expiry_discount_pct / 100.0, 2);
    END IF;

    -- Winner selection: a real promotion wins exact ties against the expiry
    -- candidate (it has no created_at to compare, D-06).
    IF v_cand_amount IS NOT NULL AND (v_expiry_amount IS NULL OR v_cand_amount >= v_expiry_amount) THEN
      v_line_discount := v_cand_amount;
      v_promo_id := v_cand_id;
      v_promo_rate := v_cand_rate;
    ELSIF v_expiry_amount IS NOT NULL THEN
      v_line_discount := v_expiry_amount;
      v_promo_id := NULL;
      v_promo_rate := v_near_expiry_discount_pct;
    ELSE
      v_line_discount := 0;
      v_promo_id := NULL;
      v_promo_rate := NULL;
    END IF;

    -- Defensive cap regardless of which candidate won (promotions.discount_value
    -- is DB-CHECK-bounded, but settings.near_expiry.discountPercent is a bare
    -- jsonb value with no DB constraint) — a winning discount can never
    -- exceed the line's expected price, so v_line_price can never go
    -- negative before the floor guard below even runs.
    v_line_discount := LEAST(v_line_discount, v_expected_price);

    -- Below-cost floor guard (PROMO-07/D-07/D-08): floor is exactly cost (0%
    -- margin), compared pre-tax/pre-modifier; a product with no inventory
    -- row (cost_price NULL) never trips it. Block + require manager
    -- override — never silent-cap, never silent-drop.
    v_line_price := v_expected_price - v_line_discount;
    IF v_line_price < COALESCE(v_cost_price, 0) AND NOT p_manager_override THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BELOW_COST_REQUIRES_OVERRIDE', 'message', 'This combination of discounts would sell below cost');
    END IF;

    IF v_line_discount > 0 THEN
      PERFORM record_audit('promotion.apply', 'order_item', v_promo_id, NULL,
        jsonb_build_object('productId', v_elem->>'product_id', 'discountAmount', v_line_discount, 'discountRate', v_promo_rate),
        'rpc');
    END IF;

    v_modifier_ids := COALESCE((SELECT array_agg(value::uuid)
      FROM jsonb_array_elements_text(COALESCE(v_elem->'modifier_ids', '[]'::jsonb)) AS t(value)), ARRAY[]::uuid[]);
    IF array_length(v_modifier_ids, 1) > 0 THEN
      IF EXISTS (SELECT 1 FROM unnest(v_modifier_ids) AS mid WHERE NOT EXISTS (
        SELECT 1 FROM product_modifiers pm WHERE pm.product_id = (v_elem->>'product_id')::uuid AND pm.modifier_id = mid
      )) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MODIFIER_MISMATCH', 'message', 'Modifier does not belong to this item''s product');
      END IF;
      SELECT COALESCE(SUM(price_delta), 0) INTO v_modifier_delta FROM modifiers WHERE id = ANY(v_modifier_ids);
    ELSE
      v_modifier_delta := 0;
    END IF;

    v_line_qty := COALESCE((v_elem->>'quantity')::int, 1);
    v_subtotal := v_subtotal + (v_line_price + v_modifier_delta) * v_line_qty;
    v_derived_items := v_derived_items || jsonb_build_object(
      'product_id', v_elem->>'product_id', 'quantity', v_line_qty, 'unit_price', v_line_price,
      'modifier_ids', to_jsonb(v_modifier_ids), 'modifier_price_delta', v_modifier_delta,
      'notes', NULLIF(v_elem->>'notes', ''), 'weight_grams', v_weight_grams,
      'cost_price_snapshot', v_cost_price,
      'promotion_id', v_promo_id, 'discount_rate', v_promo_rate, 'discount_amount', v_line_discount
    );
  END LOOP;

  -- ===== Combo pass (spec A.4/A.6) =====
  -- Expands every non-weight-sold, non-consumed unit of every line into one
  -- row of _sale_units (one unit = one physical item), matches each active
  -- combo-kind promotion's slot composition, and greedily applies the
  -- best-NET combo application each round (net = gross - already-applied
  -- per-line discounts, so a combo never "steals" savings the per-line pass
  -- already won) until none clears net > 0 or 50 rounds are hit — mirrors
  -- combo-pricing.ts's `evaluateCombos` exactly (same greedy loop, same
  -- gross formulas per discount_type, same tie-break rules).
  CREATE TEMP TABLE IF NOT EXISTS _sale_units (
    unit_no serial PRIMARY KEY, item_idx int NOT NULL, product_id uuid NOT NULL, category_id uuid NOT NULL,
    price numeric NOT NULL, line_discount numeric NOT NULL, eligible boolean NOT NULL,
    combo_promo_id uuid, combo_discount numeric, combo_rate numeric, consumed boolean NOT NULL DEFAULT false,
    app_no int
  ) ON COMMIT DROP;
  TRUNCATE _sale_units;
  INSERT INTO _sale_units (item_idx, product_id, category_id, price, line_discount, eligible)
  SELECT i.idx - 1, (i.elem->>'product_id')::uuid, p.category_id,
         (i.elem->>'unit_price')::numeric + (i.elem->>'discount_amount')::numeric + (i.elem->>'modifier_price_delta')::numeric,
         (i.elem->>'discount_amount')::numeric,
         p.combo_eligible AND NOT EXISTS (
           WITH RECURSIVE anc AS (
             SELECT c.id, c.parent_id, c.combo_eligible FROM categories c WHERE c.id = p.category_id
             UNION ALL SELECT c.id, c.parent_id, c.combo_eligible FROM categories c JOIN anc ON c.id = anc.parent_id)
           SELECT 1 FROM anc WHERE NOT anc.combo_eligible)
  FROM jsonb_array_elements(v_derived_items) WITH ORDINALITY AS i(elem, idx)
  JOIN products p ON p.id = (i.elem->>'product_id')::uuid
  CROSS JOIN generate_series(1, (i.elem->>'quantity')::int)
  WHERE NULLIF(i.elem->>'weight_grams', '') IS NULL AND NOT p.sold_by_weight;

  LOOP
    v_iter := v_iter + 1; EXIT WHEN v_iter > 50;
    v_best_net := 0; v_best_combo_id := NULL;
    FOR v_combo IN
      SELECT p.id, p.name, p.discount_type, p.discount_value
      FROM promotions p
      WHERE p.kind = 'combo' AND p.active AND now() BETWEEN p.starts_at AND p.ends_at
        AND (p.days_of_week IS NULL OR EXTRACT(DOW FROM now() AT TIME ZONE v_store_tz)::int = ANY(p.days_of_week))
        AND (p.start_time IS NULL OR (now() AT TIME ZONE v_store_tz)::time BETWEEN p.start_time AND p.end_time)
      ORDER BY p.created_at DESC
    LOOP
      v_app_units := ARRAY[]::int[]; v_sum := 0;
      FOR v_slot IN SELECT s.id, s.quantity FROM promotion_combo_slots s WHERE s.promotion_id = v_combo.id ORDER BY s.position LOOP
        -- Review fix (round 1, Critical): v_slot_units is a dedicated
        -- per-slot scratch array — NEVER v_best_units, which must hold only
        -- the winning application's units (written once, in the winner
        -- branch below). Aliasing the two meant this scratch write, which
        -- fires unconditionally for every slot of every candidate combo
        -- (not just the eventual winner), clobbered whatever the previous
        -- winner branch had stored, so the allocation step below could end
        -- up discounting a completely different combo's units.
        SELECT array_agg(unit_no ORDER BY price DESC, unit_no) INTO v_slot_units
        FROM (
          SELECT u.unit_no, u.price FROM _sale_units u
          WHERE NOT u.consumed AND u.eligible AND NOT (u.unit_no = ANY(v_app_units))
            AND EXISTS (
              WITH RECURSIVE anc AS (
                SELECT c.id, c.parent_id FROM categories c WHERE c.id = u.category_id
                UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN anc ON c.id = anc.parent_id)
              SELECT 1 FROM promotion_targets t WHERE t.slot_id = v_slot.id
                AND (t.product_id = u.product_id OR t.category_id IN (SELECT id FROM anc)))
          ORDER BY u.price DESC, u.unit_no LIMIT v_slot.quantity
        ) pick;
        IF v_slot_units IS NULL OR array_length(v_slot_units, 1) < v_slot.quantity THEN v_app_units := NULL; EXIT; END IF;
        v_app_units := v_app_units || v_slot_units;
      END LOOP;
      CONTINUE WHEN v_app_units IS NULL OR array_length(v_app_units, 1) IS NULL;

      SELECT SUM(price), SUM(line_discount) INTO v_sum, v_alloc FROM _sale_units WHERE unit_no = ANY(v_app_units);
      v_gross := CASE v_combo.discount_type
        WHEN 'bundle_price'  THEN GREATEST(0, ROUND(v_sum - v_combo.discount_value, 2))
        WHEN 'percent'       THEN (SELECT SUM(ROUND(price * v_combo.discount_value / 100.0, 2)) FROM _sale_units WHERE unit_no = ANY(v_app_units))
        WHEN 'fixed'         THEN LEAST(v_combo.discount_value, v_sum)
        WHEN 'cheapest_free' THEN (SELECT COALESCE(SUM(price),0) FROM (SELECT price FROM _sale_units WHERE unit_no = ANY(v_app_units) ORDER BY price ASC, unit_no LIMIT v_combo.discount_value::int) c)
        ELSE 0 END;
      v_net := v_gross - v_alloc;
      IF v_gross > 0 AND v_net > v_best_net THEN
        v_best_net := v_net; v_best_combo_id := v_combo.id; v_best_gross := v_gross;
        v_best_type := v_combo.discount_type; v_best_value := v_combo.discount_value;
        SELECT array_agg(unit_no ORDER BY unit_no) INTO v_best_units FROM _sale_units WHERE unit_no = ANY(v_app_units);
      END IF;
    END LOOP;
    EXIT WHEN v_best_combo_id IS NULL;
    v_app_no := v_app_no + 1;

    -- allocate v_best_gross over v_best_units (spec A.4 allocation rules)
    IF v_best_type = 'cheapest_free' THEN
      UPDATE _sale_units SET combo_discount = 0 WHERE unit_no = ANY(v_best_units);
      UPDATE _sale_units SET combo_discount = price WHERE unit_no IN (
        SELECT unit_no FROM _sale_units WHERE unit_no = ANY(v_best_units) ORDER BY price ASC, unit_no LIMIT v_best_value::int);
    ELSIF v_best_type = 'percent' THEN
      UPDATE _sale_units SET combo_discount = ROUND(price * v_best_value / 100.0, 2) WHERE unit_no = ANY(v_best_units);
    ELSE  -- bundle_price / fixed: proportional, remainder on the last unit, then clamp+redistribute
      SELECT SUM(price) INTO v_sum FROM _sale_units WHERE unit_no = ANY(v_best_units);
      v_running := 0; v_n := array_length(v_best_units, 1);
      FOR v_idx IN 1..v_n LOOP
        IF v_idx = v_n THEN v_alloc := ROUND(v_best_gross - v_running, 2);
        ELSE SELECT ROUND(v_best_gross * price / v_sum, 2) INTO v_alloc FROM _sale_units WHERE unit_no = v_best_units[v_idx]; END IF;
        UPDATE _sale_units SET combo_discount = v_alloc WHERE unit_no = v_best_units[v_idx];
        v_running := v_running + v_alloc;
      END LOOP;

      -- Required correction (ported from combo-pricing.ts's priceApplication
      -- clamp/redistribute pass, the same bug fixed client-side in Task 3):
      -- the naive proportional allocation above is not bounded by a unit's
      -- own price — the remainder always lands on the LAST unit in ascending
      -- unit_no order, which can be a cheap one. Clamp every unit to its own
      -- price, collect the overflow, and push it back onto earlier units'
      -- remaining headroom (ascending unit_no) until fully placed — always
      -- satisfiable because v_best_gross <= v_sum by construction for both
      -- bundle_price (GREATEST(0, sum - value)) and fixed (LEAST(value, sum)).
      v_residual := 0;
      FOR v_idx IN 1..v_n LOOP
        SELECT price, combo_discount INTO v_unit_price, v_unit_discount
        FROM _sale_units WHERE unit_no = v_best_units[v_idx];
        IF v_unit_discount > v_unit_price THEN
          v_residual := ROUND(v_residual + (v_unit_discount - v_unit_price), 2);
          UPDATE _sale_units SET combo_discount = v_unit_price WHERE unit_no = v_best_units[v_idx];
        END IF;
      END LOOP;
      IF v_residual > 0 THEN
        FOR v_idx IN 1..v_n LOOP
          EXIT WHEN v_residual <= 0;
          SELECT price - combo_discount INTO v_unit_price -- reused as headroom
          FROM _sale_units WHERE unit_no = v_best_units[v_idx];
          IF v_unit_price > 0 THEN
            v_unit_price := LEAST(v_unit_price, v_residual);
            UPDATE _sale_units SET combo_discount = combo_discount + v_unit_price WHERE unit_no = v_best_units[v_idx];
            v_residual := ROUND(v_residual - v_unit_price, 2);
          END IF;
        END LOOP;
      END IF;
    END IF;
    UPDATE _sale_units SET consumed = true, combo_promo_id = v_best_combo_id,
      combo_rate = CASE WHEN v_best_type = 'percent' THEN v_best_value ELSE NULL END,
      app_no = v_app_no
    WHERE unit_no = ANY(v_best_units);
  END LOOP;

  -- Re-materialise v_derived_items when at least one combo application
  -- consumed units: every group (item_idx, consumed, combo_promo_id,
  -- combo_discount) becomes one order_items row; unconsumed units copy the
  -- original element with only 'quantity' replaced. Weight-sold lines never
  -- entered _sale_units and are appended unchanged.
  IF EXISTS (SELECT 1 FROM _sale_units WHERE consumed) THEN
    v_before := v_derived_items; v_derived_items := '[]'::jsonb; v_subtotal := 0;

    -- Review fix (round 1, Important #1 — product decision): the below-cost
    -- floor guard for combo-consumed units is checked once per WHOLE
    -- application (Σrevenue vs Σcost across every unit that ONE combo
    -- application produced), not per resulting row. A per-row check (the
    -- prior version of this migration) trips on essentially every
    -- cheapest_free combo, since the freed unit's own row is priced 0 —
    -- below any positive cost — even though the other units in the same
    -- application cover the margin, which is the entire point of the
    -- mechanic. `revenue`/`cost` here mirror the exact per-row formula this
    -- replaces (unit_price + discount_amount - combo_discount vs
    -- cost_price_snapshot, modifier_price_delta excluded, same as the
    -- original per-line floor guard above), just summed per app_no instead
    -- of applied per row.
    FOR v_grp IN
      SELECT u.app_no,
        SUM((o.orig->>'unit_price')::numeric + (o.orig->>'discount_amount')::numeric - u.combo_discount) AS revenue,
        SUM(COALESCE((o.orig->>'cost_price_snapshot')::numeric, 0)) AS cost
      FROM _sale_units u
      JOIN LATERAL (
        SELECT elem FROM jsonb_array_elements(v_before) WITH ORDINALITY d(elem, i) WHERE d.i - 1 = u.item_idx
      ) o(orig) ON true
      WHERE u.consumed
      GROUP BY u.app_no
    LOOP
      IF v_grp.revenue < v_grp.cost AND NOT p_manager_override THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BELOW_COST_REQUIRES_OVERRIDE', 'message', 'This combination of discounts would sell below cost');
      END IF;
    END LOOP;

    FOR v_grp IN
      SELECT u.item_idx, u.consumed, u.combo_promo_id, u.combo_rate, u.combo_discount, COUNT(*)::int AS qty,
             (SELECT elem FROM jsonb_array_elements(v_before) WITH ORDINALITY d(elem, i) WHERE d.i - 1 = u.item_idx) AS orig
      FROM _sale_units u
      GROUP BY u.item_idx, u.consumed, u.combo_promo_id, u.combo_rate, u.combo_discount
      ORDER BY u.item_idx, u.consumed, u.combo_discount
    LOOP
      IF v_grp.consumed THEN
        -- unit_price = catalog price (orig unit_price + orig discount) - combo
        -- discount, modifier delta stays separate. The below-cost check
        -- already ran once per application above; GREATEST(0, ...) here is
        -- only a defensive backstop (never the below-cost decision itself)
        -- so a unit whose modifier delta interacts with the combo discount
        -- can never compute a small negative value that would otherwise trip
        -- order_items' raw CHECK constraint with an unformatted DB error.
        v_line_price := GREATEST(0, ROUND((v_grp.orig->>'unit_price')::numeric + (v_grp.orig->>'discount_amount')::numeric - v_grp.combo_discount, 2));
        v_derived_items := v_derived_items || (v_grp.orig || jsonb_build_object(
          'quantity', v_grp.qty, 'unit_price', v_line_price,
          'promotion_id', v_grp.combo_promo_id, 'discount_rate', v_grp.combo_rate, 'discount_amount', v_grp.combo_discount));
      ELSE
        v_derived_items := v_derived_items || (v_grp.orig || jsonb_build_object('quantity', v_grp.qty));
      END IF;
    END LOOP;
    -- weight lines never entered _sale_units: append them unchanged
    FOR v_elem IN SELECT elem FROM jsonb_array_elements(v_before) WITH ORDINALITY d(elem, i)
                  WHERE NOT EXISTS (SELECT 1 FROM _sale_units u WHERE u.item_idx = d.i - 1) LOOP
      v_derived_items := v_derived_items || v_elem;
    END LOOP;
    SELECT ROUND(SUM(((e->>'unit_price')::numeric + (e->>'modifier_price_delta')::numeric) * (e->>'quantity')::int), 2)
      INTO v_subtotal FROM jsonb_array_elements(v_derived_items) e;
    -- one audit row per combo application
    FOR v_grp IN SELECT combo_promo_id, SUM(combo_discount) AS total FROM _sale_units WHERE consumed GROUP BY combo_promo_id LOOP
      PERFORM record_audit('promotion.apply', 'order_item', v_grp.combo_promo_id, NULL,
        jsonb_build_object('kind', 'combo', 'discountAmount', v_grp.total), 'rpc');
    END LOOP;
  END IF;

  v_subtotal := ROUND(v_subtotal, 2);

  -- Ad-hoc whole-sale discount (PROMO-05/D-10) — mirrors
  -- src/shared/lib/domain-helpers.ts's calculateDiscountAmount exactly.
  -- Authorization (p_manager_override + role re-check) already validated
  -- above; discountScope is restricted to 'all'.
  IF p_discount_scope IS NOT NULL THEN
    v_adhoc_discount := ROUND(LEAST(
      CASE WHEN p_discount_type = 'percent' THEN v_subtotal * (p_discount_value / 100.0) ELSE p_discount_value END,
      v_subtotal), 2);
    v_subtotal := ROUND(v_subtotal - v_adhoc_discount, 2);
  ELSE
    v_adhoc_discount := NULL;
  END IF;

  SELECT COALESCE((value->>'taxRatePercent')::numeric, 16), COALESCE((value->>'taxInclusive')::boolean, true)
    INTO v_tax_rate, v_tax_inclusive FROM settings WHERE key = 'billing';
  -- No 'billing' row at all (zero rows, distinct from a row missing the
  -- taxInclusive key -- the inline COALESCE above only fires when a row is
  -- returned) leaves both v_tax_rate/v_tax_inclusive NULL after SELECT INTO.
  -- v_tax_rate already had this exact fallback; v_tax_inclusive needs the
  -- same one so a pre-existing/missing settings row never silently resolves
  -- to exclusive mode (D-01).
  v_tax_rate := COALESCE(v_tax_rate, 16);
  v_tax_inclusive := COALESCE(v_tax_inclusive, true);
  IF v_tax_inclusive THEN
    v_derived_total := v_subtotal;
    v_tax := ROUND(v_subtotal - ROUND(v_subtotal / (1 + v_tax_rate / 100.0), 2), 2);
  ELSE
    v_tax := ROUND(v_subtotal * (v_tax_rate / 100.0), 2);
    v_derived_total := ROUND(v_subtotal + v_tax, 2);
  END IF;
  IF p_legs IS NULL THEN
    IF p_amount IS NULL OR abs(p_amount - v_derived_total) > 0.01 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'AMOUNT_MISMATCH', 'message', 'Payment amount does not match the derived sale total');
    END IF;
  ELSE
    IF p_expected_total IS NULL OR abs(p_expected_total - v_derived_total) > 0.01 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'AMOUNT_MISMATCH', 'message', 'Expected total does not match the derived sale total');
    END IF;
  END IF;

  INSERT INTO tabs (customer_name, staff_id, shift_id, caja_session_id, status)
  VALUES (p_customer_name, p_staff_id, p_shift_id, p_caja_session_id, 'open') RETURNING id INTO v_tab_id;
  INSERT INTO orders (tab_id, staff_id, status, notes) VALUES (v_tab_id, p_staff_id, 'pending', NULL) RETURNING id INTO v_order_id;
  INSERT INTO order_items (order_id, product_id, quantity, unit_price, modifier_ids, modifier_price_delta, notes, weight_grams, cost_price_snapshot, promotion_id, discount_rate, discount_amount)
  SELECT v_order_id, (elem->>'product_id')::uuid, (elem->>'quantity')::int, (elem->>'unit_price')::numeric,
    COALESCE((SELECT array_agg(value::uuid) FROM jsonb_array_elements_text(COALESCE(elem->'modifier_ids', '[]'::jsonb)) AS t(value)), ARRAY[]::uuid[]),
    (elem->>'modifier_price_delta')::numeric, elem->>'notes', NULLIF((elem->>'weight_grams')::text, '')::integer,
    (elem->>'cost_price_snapshot')::numeric,
    NULLIF(elem->>'promotion_id', '')::uuid, (elem->>'discount_rate')::numeric, (elem->>'discount_amount')::numeric
  FROM jsonb_array_elements(v_derived_items) AS elem;

  IF p_legs IS NULL THEN
    -- WR-03 fix: authorize the one legitimate bank_transfer caller (this
    -- freshly-inserted tab, same transaction) via a transaction-local GUC —
    -- see the matching check in process_payment_atomic.
    IF p_method = 'bank_transfer' THEN
      PERFORM set_config('app.bank_transfer_checkout_context', 'true', true);
    END IF;
    -- Phase 27 Plan 09 (G-27-13): forward this call's OWN already-validated
    -- p_manager_override/p_manager_pin through — process_payment_atomic now
    -- independently re-verifies a manager override too (added above), and
    -- without forwarding these values the inner check would reject every
    -- ad-hoc-discounted direct sale a second time with default false/NULL.
    v_result := process_payment_atomic(p_tab_id := v_tab_id, p_staff_id := p_staff_id, p_amount := p_amount,
      p_method := p_method, p_idempotency_key := p_idempotency_key, p_tendered_amount := p_tendered_amount,
      p_reference_number := p_reference_number, p_discount_scope := p_discount_scope, p_discount_type := p_discount_type,
      p_discount_value := p_discount_value, p_discount_amount := v_adhoc_discount, p_customer_phone := p_customer_phone,
      p_manager_override := p_manager_override, p_manager_pin := p_manager_pin);
  ELSE
    -- Phase 27 Plan 09 (G-27-13): same forwarding rationale as the
    -- process_payment_atomic delegation above, for process_split_payment_atomic.
    v_result := process_split_payment_atomic(p_tab_id := v_tab_id, p_staff_id := p_staff_id, p_legs := p_legs,
      p_expected_total := p_expected_total, p_idempotency_key := p_idempotency_key, p_discount_scope := p_discount_scope,
      p_discount_type := p_discount_type, p_discount_value := p_discount_value, p_discount_amount := v_adhoc_discount,
      p_manager_override := p_manager_override, p_manager_pin := p_manager_pin);
  END IF;
  IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN RAISE EXCEPTION 'DIRECT_SALE_PAYMENT_FAILED: %', v_result->>'message'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tabs WHERE id = v_tab_id AND status = 'paid') THEN
    RAISE EXCEPTION 'DIRECT_SALE_PAYMENT_FAILED: %', 'Payment did not cover the sale total';
  END IF;
  RETURN jsonb_build_object('ok', true, 'tabId', v_tab_id, 'paymentId', v_result->>'paymentId',
    'paymentGroupId', v_result->>'paymentGroupId', 'paymentIds', v_result->'paymentIds',
    'idempotent', COALESCE((v_result->>'idempotent')::boolean, false));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'code', 'DIRECT_SALE_FAILED', 'message', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.process_direct_sale_atomic(uuid, uuid, uuid, jsonb, text, text, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text, text, boolean, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_direct_sale_atomic(uuid, uuid, uuid, jsonb, text, text, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text, text, boolean, text, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
