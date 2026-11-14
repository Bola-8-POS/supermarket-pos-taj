-- Makes process_refund replay-safe using the generic idempotency ledger from
-- 20260929000001_rpc_idempotency_ledger.sql. Today a byte-identical replay of
-- a refund call (a retried offline-queue mutation, a double-tap, a retried
-- HTTP call) passes every over-refund guard again and creates a second
-- refunds row, a second negative payments row, and a second real inventory
-- restock -- its internal 'refund-' || v_refund_id key is generated fresh on
-- every call and detects nothing (recon R2 §B4).
--
-- Deviation from the plan's literal Step 3 pseudocode (documented per
-- constraints.md's deviation-handling policy, smallest change that satisfies
-- the plan's intent): the plan's snippet names v_staff_id as the
-- idempotency-ledger scope and says to place the replay check "before the
-- approval-ticket resolution" -- but v_staff_id is only ever assigned FROM
-- that approval-ticket resolution (resolve_manager_approval), so it does not
-- exist yet at a point genuinely before it. Placing the replay check before
-- resolve_manager_approval() is exactly what the plan's own Review Focus
-- requires: a replay must succeed even after the original call's single-use
-- approval ticket has already been consumed, and a replay arriving after
-- resolve_manager_approval() would either try to re-consume a ticket that is
-- already gone (INVALID_APPROVAL) or silently require a fresh one. So the
-- scope identity used below is v_caller (auth.uid(), the authenticated RPC
-- caller -- already declared in this function and assigned from auth.uid()
-- a few lines further down) rather than v_staff_id (the ticket's approver,
-- who is resolved later and is not necessarily the same person retrying the
-- call). v_caller is resolved once, early, and reused unchanged for both
-- idempotency_begin and idempotency_commit so a caller's replay always
-- matches the row its own original call created.
DROP FUNCTION IF EXISTS public.process_refund(uuid, jsonb, text, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.process_refund(
  p_original_payment_id uuid,
  p_items jsonb,
  p_reason text,
  p_approval_id uuid DEFAULT NULL::uuid,
  p_approver_id uuid DEFAULT NULL::uuid,
  p_caja_session_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
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
  v_line record;
  v_refunded_qty integer;
  v_refunded_amount numeric;
  v_line_cap numeric;
  v_caller uuid;
  v_tax_rate numeric;
  v_tax_inclusive boolean;
  v_replay jsonb;
BEGIN
  -- 0. Resolve the caller early (ahead of the approval-ticket resolution
  -- below) so a replay can be detected and returned before ever touching the
  -- single-use approval ticket -- see the deviation note above. Harmless
  -- no-op re-assignment further down (existing line, untouched) keeps this
  -- diff additive rather than a relocation.
  v_caller := auth.uid();

  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public.idempotency_begin(
      p_idempotency_key,
      'process_refund',
      v_caller,
      p_original_payment_id::text || '|' || coalesce(p_items::text, '') || '|' || coalesce(p_reason, '')
    );
    IF v_replay IS NOT NULL THEN
      RETURN (v_replay->>'refundId')::uuid;
    END IF;
  END IF;

  -- 1. Resolve the APPROVING staff member from the approval ticket (and the
  -- approver's id when the client sends it), never from the caller's own
  -- session role. Attempts are limited per caller.
  v_approval := resolve_manager_approval(p_approval_id, p_approver_id, 'process_refund', auth.uid());
  IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
    RETURN NULL;
  END IF;
  v_staff_id := (v_approval->>'approver_id')::uuid;
  v_caller := auth.uid();

  -- 1b. When a caja session is named, it must be open before any write. An
  -- old client that omits the argument falls back to the tab's own session
  -- (unchanged behavior below).
  IF p_caja_session_id IS NOT NULL THEN
    PERFORM 1 FROM caja_sessions WHERE id = p_caja_session_id AND status = 'open' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAJA_SESSION_NOT_OPEN';
    END IF;
  END IF;

  -- 2. Get original payment (must not itself be a refund, and must not
  --    already be voided by a reopen)
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
    SELECT oi.id, oi.product_id, oi.quantity, oi.unit_price, COALESCE(oi.modifier_price_delta, 0) AS modifier_price_delta
      INTO v_line
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE oi.id = (v_item->>'order_item_id')::uuid
       AND o.tab_id = v_payment.tab_id
     FOR UPDATE OF oi;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_NOT_IN_ORIGINAL_ORDER: item % not in payment''s tab',
        v_item->>'order_item_id';
    END IF;
    IF (v_item->>'qty')::integer IS NULL OR (v_item->>'qty')::integer <= 0
       OR (v_item->>'amount')::numeric IS NULL OR (v_item->>'amount')::numeric < 0 THEN
      RAISE EXCEPTION 'REFUND_ITEM_INVALID: item % has a non-positive quantity or a negative amount',
        v_item->>'order_item_id';
    END IF;
    SELECT COALESCE(SUM(ri.qty), 0), COALESCE(SUM(ri.amount), 0)
      INTO v_refunded_qty, v_refunded_amount
      FROM refund_items ri
     WHERE ri.order_item_id = v_line.id;
    IF (v_item->>'qty')::integer > v_line.quantity - v_refunded_qty THEN
      RAISE EXCEPTION 'REFUND_QTY_EXCEEDS_LINE: item % refund quantity % exceeds remaining %',
        v_line.id, (v_item->>'qty')::integer, v_line.quantity - v_refunded_qty;
    END IF;
    v_line_cap := ROUND((v_line.unit_price + v_line.modifier_price_delta) * v_line.quantity, 2) - v_refunded_amount;
    IF (v_item->>'amount')::numeric > v_line_cap + 0.01 THEN
      RAISE EXCEPTION 'REFUND_AMOUNT_EXCEEDS_LINE: item % refund amount % exceeds remaining %',
        v_line.id, (v_item->>'amount')::numeric, v_line_cap;
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
      PERFORM consume_open_unit(v_line.product_id, (v_item->>'qty')::integer, v_line.id, (-1)::smallint, true);
    END IF;
  END LOOP;

  -- 8. Tax snapshot: copy the original payment row's rate when present,
  -- else the current setting (an original row from before this wave has
  -- NULL there).
  IF v_payment.tax_rate_percent IS NOT NULL AND v_payment.tax_inclusive IS NOT NULL THEN
    v_tax_rate := v_payment.tax_rate_percent;
    v_tax_inclusive := v_payment.tax_inclusive;
  ELSE
    SELECT rate_percent, inclusive INTO v_tax_rate, v_tax_inclusive FROM billing_tax_settings();
  END IF;

  -- 9. Insert negative payment row, attributed to the paying session when named.
  INSERT INTO payments (tab_id, amount, method, processed_at, processed_by, approved_by, is_refund, refund_id, idempotency_key, caja_session_id, tax_amount, tax_rate_percent, tax_inclusive)
  VALUES (
    v_payment.tab_id,
    -v_refund_total,
    v_payment.method,
    now(),
    v_caller,
    v_staff_id,
    true,
    v_refund_id,
    'refund-' || v_refund_id::text,
    p_caja_session_id,
    payment_tax_amount(-v_refund_total, v_tax_rate, v_tax_inclusive),
    v_tax_rate,
    v_tax_inclusive
  );

  -- 10. Legacy audit_log table (kept for backward compat; will be removed in Phase 22)
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

  -- AUDIT: record refund
  SELECT to_jsonb(r) || jsonb_build_object('approved_by', v_staff_id, 'cajaSessionId', p_caja_session_id)
    INTO v_refund_row FROM refunds r WHERE r.id = v_refund_id;
  PERFORM record_audit(
    'payment.refund',
    'payment',
    p_original_payment_id,
    to_jsonb(v_payment),
    v_refund_row,
    'rpc'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.idempotency_commit(
      p_idempotency_key,
      'process_refund',
      v_caller,
      p_original_payment_id::text || '|' || coalesce(p_items::text, '') || '|' || coalesce(p_reason, ''),
      jsonb_build_object('refundId', v_refund_id)
    );
  END IF;

  RETURN v_refund_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.process_refund(uuid, jsonb, text, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_refund(uuid, jsonb, text, uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_refund(uuid, jsonb, text, uuid, uuid, uuid, text) TO service_role;
