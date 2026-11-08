-- =============================================================================
-- Phase 23 Plan 03: Fix payment-summing sites to exclude reopened_void rows
--
-- Plan 02 (20260720000002_payments_status_column.sql) added
-- payments.status ('completed'|'reopened_void'). This migration patches every
-- pre-existing function that sums the payments table so a reopened_void row
-- (voided by reopen_tab, Plan 02) no longer counts as real money. Without this,
-- re-paying a reopened tab double-counts the voided original, caja reports
-- inflate revenue, tip pooling distributes voided tips, and a manager could
-- refund an already-voided payment (RESEARCH.md Pitfalls 3-6).
--
-- A3 re-grep verification (RESEARCH.md Assumptions Log A3): re-ran
-- `grep -rln "FROM payments" supabase/migrations/` at execution time. All hits
-- resolve to the same 5 functions named in RESEARCH.md/PATTERNS.md (older
-- migration files are prior CREATE OR REPLACE generations of the same 5
-- functions, superseded by the ones patched below). No 6th site found —
-- list_caja_sessions (the only other candidate touched by that grep search)
-- does not query payments at all.
--
-- Each function below is a full-body CREATE OR REPLACE copied verbatim from
-- its latest prior migration with ONLY the reopened_void exclusion clause(s)
-- added (targeted addition, not a rewrite) — signature, SECURITY DEFINER,
-- search_path, and GRANTs preserved exactly so no new overload is created.
--
-- NOT pushed here — the BLOCKING `npx supabase db push` is Plan 04's scope.
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. process_payment_atomic — add status exclusion to the v_paid_line sum.
--    Source body: 20260512000002_rpc_versioned_group_a.sql (latest).
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
  p_discount_amount NUMERIC DEFAULT NULL,
  p_expected_version INT DEFAULT NULL
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
  v_current INT;
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

  -- Phase 15: lock tab row + assert expected_version (canonical guard).
  -- Combined with status/rappi read into a single FOR UPDATE select.
  SELECT status, rappi_order_id, version
  INTO v_tab_status, v_rappi_tab, v_current
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

  -- Phase 23: exclude reopened_void rows (voided by reopen_tab) from the
  -- "already paid" sum so a reopened-then-repaid tab is not double-counted.
  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0) INTO v_paid_line
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false
    AND p.status IS DISTINCT FROM 'reopened_void';

  -- Close only when the tab's item subtotal is fully covered (multi-pay / split).
  -- Phase 15: bump tabs.version on close. The bump_version_on_update trigger
  -- enforces +1 advancement.
  IF v_paid_line + 0.0001 >= v_owed THEN
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
$$;

REVOKE ALL ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT) TO service_role;

-- -----------------------------------------------------------------------
-- 2. process_split_payment_atomic — identical exclusion added to its
--    v_paid_line sum. Source body: 20260707000003_split_payment_columns_and_rpc.sql
--    (latest). get_payments_split_columns (same source file) is an
--    introspection helper, not a payment-summing site — untouched here.
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_split_payment_atomic(
  p_tab_id UUID,
  p_staff_id UUID,
  p_legs JSONB,              -- [{method, amount, tipAmount, tenderedAmount, referenceNumber, rappiOrderId}, ...] 1..4 entries
  p_expected_total NUMERIC,  -- client-computed subtotalWithTax; SUM(leg.amount) must equal this (+/-0.01)
  p_idempotency_key TEXT,
  p_discount_scope TEXT DEFAULT NULL,
  p_discount_type TEXT DEFAULT NULL,
  p_discount_value NUMERIC DEFAULT NULL,
  p_discount_amount NUMERIC DEFAULT NULL,
  p_expected_version INT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_leg_count       INT;
  v_existing_id     UUID;
  v_existing_group  UUID;
  v_payment_ids     UUID[];
  v_tab_status      tab_status;
  v_rappi_tab       TEXT;
  v_current         INT;
  v_open_pool       INT;
  v_legs_sum        NUMERIC;
  v_group_id        UUID;
  v_i               INT;
  v_leg             JSONB;
  v_method          TEXT;
  v_leg_amount      NUMERIC;
  v_leg_tip         NUMERIC;
  v_leg_tendered    NUMERIC;
  v_leg_ref         TEXT;
  v_leg_rappi       TEXT;
  v_payment_id      UUID;
  v_owed            NUMERIC;
  v_paid_line       NUMERIC;
  v_tab_updated     INT;
BEGIN
  -- 1. FORBIDDEN guard
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_staff_id AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Staff not found or inactive');
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
  SELECT status, rappi_order_id, version
  INTO v_tab_status, v_rappi_tab, v_current
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

  -- 5. Pool-session-active guard (stop pool before payment)
  SELECT COUNT(*)::INT INTO v_open_pool
  FROM pool_sessions
  WHERE tab_id = p_tab_id AND stopped_at IS NULL;

  IF v_open_pool > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'POOL_SESSION_ACTIVE', 'message', 'Stop pool session before payment');
  END IF;

  -- 6. Sum validation (D-05) — server-side authoritative check
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
    v_leg_tip      := COALESCE((v_leg->>'tipAmount')::numeric, 0);
    v_leg_tendered := (v_leg->>'tenderedAmount')::numeric;
    v_leg_ref      := v_leg->>'referenceNumber';
    v_leg_rappi    := v_leg->>'rappiOrderId';

    IF v_method NOT IN ('cash', 'card', 'rappi') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Payment method must be cash, card, or rappi');
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
      IF ROUND(v_leg_tendered, 2) < ROUND(v_leg_amount + v_leg_tip, 2) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_TENDER', 'message', 'Tendered amount is less than leg total');
      END IF;
    ELSE
      IF v_leg_tendered IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'TENDERED_NOT_ALLOWED', 'message', 'Tendered amount is only for cash payments');
      END IF;
    END IF;

    IF v_method = 'rappi' THEN
      IF v_rappi_tab IS NULL OR v_rappi_tab IS DISTINCT FROM v_leg_rappi THEN
        RETURN jsonb_build_object('ok', false, 'code', 'RAPPI_ORDER_MISMATCH', 'message', 'Rappi order id does not match tab');
      END IF;
    END IF;

    -- Discount stored ONLY on split_index=0 (D-04: discount computed once on
    -- the full tab, not per row — avoids double-count in SUM(discount_amount)
    -- reports).
    INSERT INTO payments (
      tab_id,
      amount,
      tip_amount,
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
      discount_amount
    ) VALUES (
      p_tab_id,
      ROUND(v_leg_amount, 2),
      ROUND(v_leg_tip, 2),
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
      CASE WHEN v_i = 0 THEN p_discount_amount ELSE NULL END
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
  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0) INTO v_paid_line
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false
    AND p.status IS DISTINCT FROM 'reopened_void';

  IF v_paid_line + 0.0001 >= v_owed THEN
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
    jsonb_build_object('paymentIds', to_jsonb(v_payment_ids), 'legCount', v_leg_count),
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
$$;

-- Called via the edge function's service-role admin client (mirrors
-- process_payment_atomic — never called directly by an authenticated user).
REVOKE ALL ON FUNCTION public.process_split_payment_atomic(UUID, UUID, JSONB, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_split_payment_atomic(UUID, UUID, JSONB, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT) TO service_role;

-- -----------------------------------------------------------------------
-- 3. process_refund — extend the original-payment lookup guard to also
--    reject a reopened_void row (falls into the existing NOT_FOUND path,
--    no new error code — Pitfall 6). Source body:
--    20260708000003_fix_process_refund_audit_log_column.sql (latest).
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

-- -----------------------------------------------------------------------
-- 4. get_caja_report — add status exclusion to BOTH the top-level revenue
--    aggregate AND the per-staff sales_total subquery. These queries
--    currently have no is_refund filter at all (refunds net out as negative
--    amounts) — a reopened_void row is NOT negative, so it MUST be excluded
--    explicitly (Pitfall 4). Source body: 20260421000004_caja_report_entries.sql
--    (latest).
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_caja_report(p_caja_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caja            RECORD;
  v_tab_ids         UUID[];
  v_total_revenue   NUMERIC(12,2);
  v_cash_sales      NUMERIC(12,2);
  v_card_sales      NUMERIC(12,2);
  v_rappi_sales     NUMERIC(12,2);
  v_order_count     INT;
  v_tab_count       INT;
  v_top_products    JSON;
  v_staff_summary   JSON;
  v_opened_by_name  TEXT;
  v_closed_by_name  TEXT;
  v_entries         JSON;
  v_total_expenses  NUMERIC(12,2) := 0;
  v_total_income    NUMERIC(12,2) := 0;
BEGIN
  -- Fetch caja session
  SELECT
    cs.*,
    op.name AS opened_by_name,
    cp.name AS closed_by_name
  INTO v_caja
  FROM caja_sessions cs
  LEFT JOIN profiles op ON op.id = cs.opened_by
  LEFT JOIN profiles cp ON cp.id = cs.closed_by
  WHERE cs.id = p_caja_id;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND', 'message', 'Caja session not found.'
    ));
  END IF;

  -- Collect tab ids for this caja
  SELECT array_agg(id) INTO v_tab_ids
  FROM tabs
  WHERE caja_session_id = p_caja_id AND is_deleted = FALSE;

  IF v_tab_ids IS NULL THEN
    v_tab_ids := '{}';
  END IF;

  v_tab_count := coalesce(array_length(v_tab_ids, 1), 0);

  -- Payment aggregates. Phase 23: exclude reopened_void rows so a voided
  -- original payment (un-done by reopen_tab) does not inflate revenue.
  SELECT
    COALESCE(SUM(amount + tip_amount), 0),
    COALESCE(SUM(CASE WHEN method = 'cash'  THEN amount + tip_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'card'  THEN amount + tip_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'rappi' THEN amount + tip_amount ELSE 0 END), 0)
  INTO v_total_revenue, v_cash_sales, v_card_sales, v_rappi_sales
  FROM payments
  WHERE tab_id = ANY(v_tab_ids)
    AND is_deleted = FALSE
    AND status IS DISTINCT FROM 'reopened_void';

  -- Order count
  SELECT COUNT(*) INTO v_order_count
  FROM orders
  WHERE tab_id = ANY(v_tab_ids)
    AND status <> 'voided'
    AND is_deleted = FALSE;

  -- Caja entry totals
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)
  INTO v_total_expenses, v_total_income
  FROM caja_entries
  WHERE caja_session_id = p_caja_id;

  -- Caja entries list
  SELECT COALESCE(json_agg(
    json_build_object(
      'id',             e.id,
      'cajaSessionId',  e.caja_session_id,
      'type',           e.type,
      'amount',         e.amount,
      'concept',        e.concept,
      'createdAt',      e.created_at,
      'staffId',        e.staff_id,
      'staffName',      p.name
    ) ORDER BY e.created_at ASC
  ), '[]'::JSON)
  INTO v_entries
  FROM caja_entries e
  JOIN profiles p ON p.id = e.staff_id
  WHERE e.caja_session_id = p_caja_id;

  -- Top 10 products by quantity sold
  SELECT json_agg(row_to_json(t)) INTO v_top_products
  FROM (
    SELECT
      p.name            AS product_name,
      SUM(oi.quantity)  AS quantity,
      SUM(oi.quantity * oi.unit_price) AS revenue
    FROM order_items oi
    JOIN orders o    ON o.id = oi.order_id
    JOIN products p  ON p.id = oi.product_id
    WHERE o.tab_id = ANY(v_tab_ids)
      AND o.status <> 'voided'
      AND o.is_deleted = FALSE
      AND oi.is_deleted = FALSE
    GROUP BY p.id, p.name
    ORDER BY quantity DESC
    LIMIT 10
  ) t;

  -- Staff performance summary. Phase 23: exclude reopened_void rows from
  -- the per-staff sales_total, same reasoning as the top-level aggregate.
  SELECT json_agg(row_to_json(s)) INTO v_staff_summary
  FROM (
    SELECT
      pr.id             AS staff_id,
      pr.name           AS staff_name,
      COUNT(DISTINCT o.id) AS order_count,
      COALESCE(SUM(pay.amount + pay.tip_amount), 0) AS sales_total
    FROM profiles pr
    LEFT JOIN orders o  ON o.staff_id = pr.id
                        AND o.tab_id = ANY(v_tab_ids)
                        AND o.status <> 'voided'
                        AND o.is_deleted = FALSE
    LEFT JOIN payments pay ON pay.tab_id = ANY(v_tab_ids)
                           AND pay.processed_by = pr.id
                           AND pay.is_deleted = FALSE
                           AND pay.status IS DISTINCT FROM 'reopened_void'
    WHERE o.id IS NOT NULL OR pay.id IS NOT NULL
    GROUP BY pr.id, pr.name
    ORDER BY sales_total DESC
  ) s;

  RETURN json_build_object(
    'ok', true,
    'cajaSession', json_build_object(
      'id',           v_caja.id,
      'openedAt',     v_caja.opened_at,
      'closedAt',     v_caja.closed_at,
      'openedBy',     v_caja.opened_by,
      'openedByName', v_caja.opened_by_name,
      'closedBy',     v_caja.closed_by,
      'closedByName', v_caja.closed_by_name,
      'openingCash',  v_caja.opening_cash,
      'closingCash',  v_caja.closing_cash,
      'notes',        v_caja.notes,
      'status',       v_caja.status
    ),
    'summary', json_build_object(
      'totalRevenue',   v_total_revenue,
      'cashSales',      v_cash_sales,
      'cardSales',      v_card_sales,
      'rappiSales',     v_rappi_sales,
      'orderCount',     v_order_count,
      'tabCount',       v_tab_count,
      'totalExpenses',  v_total_expenses,
      'totalIncome',    v_total_income,
      'netBalance',     v_cash_sales + v_card_sales + v_rappi_sales + v_total_income - v_total_expenses
    ),
    'cashReconciliation', json_build_object(
      'openingCash',  v_caja.opening_cash,
      'cashSales',    v_cash_sales,
      'expectedCash', v_caja.opening_cash + v_cash_sales,
      'closingCash',  v_caja.closing_cash,
      'variance',     CASE
        WHEN v_caja.closing_cash IS NOT NULL
        THEN v_caja.closing_cash - (v_caja.opening_cash + v_cash_sales)
        ELSE NULL
      END
    ),
    'topProducts',    COALESCE(v_top_products, '[]'::json),
    'staffSummary',   COALESCE(v_staff_summary, '[]'::json),
    'cajaEntries',    COALESCE(v_entries, '[]'::json)
  );
END;
$$;

-- -----------------------------------------------------------------------
-- 5. close_caja_session — add status exclusion to the tip-pooling
--    SUM(tip_amount). Version-sensitive: existing version + 1 bump logic
--    and every other line preserved exactly (Pitfall 5). Source body:
--    20260709000002_close_caja_session_tip_distribution.sql (latest).
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
  -- Tip distribution locals (Phase 19)
  v_tab_ids        uuid[];
  v_total_tips     numeric(10,2);
  v_config         jsonb;
  v_floor_pct      numeric(5,2);
  v_bar_pct        numeric(5,2);
  v_kitchen_pct    numeric(5,2);
  v_floor_amount   numeric(10,2);
  v_bar_amount     numeric(10,2);
  v_kitchen_amount numeric(10,2);
  v_remainder      numeric(10,2);
  v_entry_id       uuid;
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
    status       = 'closed',
    version      = version + 1
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

  -- ---------------------------------------------------------------------
  -- Phase 19: tip-bucket distribution (D-02, D-03) — same transaction
  -- ---------------------------------------------------------------------

  -- Collect this session's non-deleted tab ids (mirror get_caja_report)
  SELECT array_agg(id) INTO v_tab_ids
  FROM tabs
  WHERE caja_session_id = p_caja_id AND is_deleted = FALSE;

  IF v_tab_ids IS NULL THEN
    v_tab_ids := '{}';
  END IF;

  -- Pool tips across ALL payment methods (A2 — no rappi exclusion, Pitfall 3).
  -- Phase 23: exclude reopened_void rows so a voided payment's tip is not
  -- distributed to floor/bar/kitchen staff (Pitfall 5).
  SELECT COALESCE(SUM(tip_amount), 0) INTO v_total_tips
  FROM payments
  WHERE tab_id = ANY(v_tab_ids)
    AND is_deleted = FALSE
    AND status IS DISTINCT FROM 'reopened_void';

  -- Read the distribution config, falling back to 34/33/33 if absent (Pitfall 4)
  SELECT value INTO v_config FROM settings WHERE key = 'tip_distribution';
  IF NOT FOUND OR v_config IS NULL THEN
    v_config := '{"floorPct":34,"barPct":33,"kitchenPct":33}'::jsonb;
  END IF;

  v_floor_pct   := COALESCE((v_config->>'floorPct')::numeric, 34);
  v_bar_pct     := COALESCE((v_config->>'barPct')::numeric, 33);
  v_kitchen_pct := COALESCE((v_config->>'kitchenPct')::numeric, 33);

  -- Largest-remainder split (D-02). No sum-to-100 rejection (D-01) — zero
  -- tips naturally yield 0/0/0 with v_remainder = 0 (Pitfall 5).
  v_floor_amount   := trunc(v_total_tips * v_floor_pct / 100, 2);
  v_bar_amount     := trunc(v_total_tips * v_bar_pct / 100, 2);
  v_kitchen_amount := trunc(v_total_tips * v_kitchen_pct / 100, 2);
  v_remainder      := v_total_tips - (v_floor_amount + v_bar_amount + v_kitchen_amount);

  IF v_remainder > 0 THEN
    -- Tiebreak: assign the FULL remainder to the largest pct, floor > bar > kitchen
    IF v_floor_pct >= v_bar_pct AND v_floor_pct >= v_kitchen_pct THEN
      v_floor_amount := v_floor_amount + v_remainder;
    ELSIF v_bar_pct >= v_kitchen_pct THEN
      v_bar_amount := v_bar_amount + v_remainder;
    ELSE
      v_kitchen_amount := v_kitchen_amount + v_remainder;
    END IF;
  END IF;

  -- Sole writer of tip_distribution_entries (D-04). ON CONFLICT DO NOTHING is
  -- defense-in-depth against a re-close race — the WHERE status='open' guard
  -- above already prevents normal re-close.
  INSERT INTO tip_distribution_entries (
    caja_session_id, floor_pct, bar_pct, kitchen_pct,
    total_tips, floor_amount, bar_amount, kitchen_amount
  ) VALUES (
    p_caja_id, v_floor_pct, v_bar_pct, v_kitchen_pct,
    v_total_tips, v_floor_amount, v_bar_amount, v_kitchen_amount
  )
  ON CONFLICT (caja_session_id) DO NOTHING
  RETURNING id INTO v_entry_id;

  PERFORM record_audit('tip_distribution.compute',
    'tip_distribution_entry',
    p_caja_id,
    NULL,
    jsonb_build_object(
      'totalTips', v_total_tips,
      'floorAmount', v_floor_amount,
      'barAmount', v_bar_amount,
      'kitchenAmount', v_kitchen_amount,
      'floorPct', v_floor_pct,
      'barPct', v_bar_pct,
      'kitchenPct', v_kitchen_pct
    ),
    'rpc'
  );

  RETURN json_build_object('ok', true);
END;
$$;

COMMIT;

-- =============================================================================
-- DOWN:
-- Supabase Cloud has no automated rollback mechanism. To manually roll back
-- each of the 5 functions patched by this migration, re-run its prior
-- migration file to restore the pre-Phase-23 body:
--   - process_payment_atomic        -> 20260512000002_rpc_versioned_group_a.sql
--   - process_split_payment_atomic  -> 20260707000003_split_payment_columns_and_rpc.sql
--   - process_refund                -> 20260708000003_fix_process_refund_audit_log_column.sql
--   - get_caja_report                -> 20260421000004_caja_report_entries.sql
--   - close_caja_session             -> 20260709000002_close_caja_session_tip_distribution.sql
-- Re-running these DOES reintroduce the double-count/revenue-inflation/
-- voided-tip-distribution/double-refund bugs this migration fixes — not
-- recommended outside of an emergency rollback.
-- =============================================================================
