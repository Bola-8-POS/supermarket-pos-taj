-- Removes the live gratuity ("tip") feature end-to-end. Supermarket checkout
-- has no tipping (D-xx: this is a retail grocery POS, not a bar/restaurant).
-- This is separate from the tip_distribution_entries removal already done in
-- 20260810000010_drop_tip_distribution.sql (that dropped the floor/bar/kitchen
-- split sub-feature; this drops the underlying per-payment tip_amount itself).
--
-- No DOWN script (project convention — Supabase Cloud has no automated
-- rollback mechanism, see CLAUDE.md).

-- ============================================================================
-- 1. process_payment_atomic — drop p_tip_amount param, stop writing tip_amount
-- ============================================================================

DROP FUNCTION IF EXISTS public.process_payment_atomic(
  uuid, uuid, numeric, numeric, text, text, numeric, text, text, text, text, numeric, numeric, integer
);

CREATE FUNCTION public.process_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_amount numeric, p_method text, p_idempotency_key text, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_rappi_order_id text DEFAULT NULL::text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id UUID;
  v_existing_tab UUID;
  v_tab_status tab_status;
  v_rappi_tab TEXT;
  v_total NUMERIC;
  v_payment_id UUID;
  v_method payment_method;
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

  IF p_method = 'rappi' THEN
    IF v_rappi_tab IS NULL OR v_rappi_tab IS DISTINCT FROM p_rappi_order_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RAPPI_ORDER_MISMATCH', 'message', 'Rappi order id does not match tab');
    END IF;
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
    discount_amount
  ) VALUES (
    p_tab_id,
    ROUND(p_amount, 2),
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
$function$;

-- ============================================================================
-- 2. process_direct_sale_atomic — drop p_tip_amount param, stop forwarding it
-- ============================================================================

DROP FUNCTION IF EXISTS public.process_direct_sale_atomic(
  uuid, uuid, uuid, jsonb, text, text, numeric, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text
);

CREATE FUNCTION public.process_direct_sale_atomic(p_staff_id uuid, p_shift_id uuid, p_caja_session_id uuid, p_items jsonb, p_idempotency_key text, p_method text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_legs jsonb DEFAULT NULL::jsonb, p_expected_total numeric DEFAULT NULL::numeric, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_customer_name text DEFAULT 'Walk-in'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_payment_id uuid; v_existing_tab_id uuid; v_existing_group_id uuid; v_existing_payment_ids uuid[];
  v_existing_staff_id uuid; v_existing_shift_id uuid; v_existing_caja_id uuid;
  v_catalog_price numeric; v_expected_price numeric; v_sold_by_weight boolean; v_weight_grams integer;
  v_cost_price numeric; v_elem jsonb; v_tab_id uuid; v_order_id uuid; v_result jsonb;
  v_modifier_ids uuid[]; v_modifier_delta numeric; v_line_qty int;
  v_subtotal numeric := 0; v_tax_rate numeric; v_tax numeric; v_derived_total numeric;
  v_derived_items jsonb := '[]'::jsonb;
BEGIN
  PERFORM 1 FROM caja_sessions WHERE id = p_caja_session_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CAJA_CLOSED', 'message', 'Caja session is not open');
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
  IF (p_method IN ('cash', 'card')) = (p_legs IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Provide one payment method or split legs');
  END IF;
  IF p_discount_scope IS NOT NULL OR p_discount_type IS NOT NULL
     OR p_discount_value IS NOT NULL OR p_discount_amount IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DISCOUNT_UNSUPPORTED', 'message', 'Direct-sale discounts are not supported');
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT base_price, sold_by_weight INTO v_catalog_price, v_sold_by_weight
    FROM products WHERE id = (v_elem->>'product_id')::uuid AND is_active = true FOR UPDATE;
    IF v_catalog_price IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRICE_MISMATCH', 'message', 'Item price does not match catalog');
    END IF;
    SELECT cost_price INTO v_cost_price
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
    v_subtotal := v_subtotal + (v_expected_price + v_modifier_delta) * v_line_qty;
    v_derived_items := v_derived_items || jsonb_build_object(
      'product_id', v_elem->>'product_id', 'quantity', v_line_qty, 'unit_price', v_expected_price,
      'modifier_ids', to_jsonb(v_modifier_ids), 'modifier_price_delta', v_modifier_delta,
      'notes', NULLIF(v_elem->>'notes', ''), 'weight_grams', v_weight_grams,
      'cost_price_snapshot', v_cost_price
    );
  END LOOP;

  v_subtotal := ROUND(v_subtotal, 2);
  SELECT COALESCE((value->>'taxRatePercent')::numeric, 16) INTO v_tax_rate FROM settings WHERE key = 'billing';
  v_tax_rate := COALESCE(v_tax_rate, 16);
  v_tax := ROUND(v_subtotal * (v_tax_rate / 100.0), 2);
  v_derived_total := ROUND(v_subtotal + v_tax, 2);
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
  INSERT INTO order_items (order_id, product_id, quantity, unit_price, modifier_ids, modifier_price_delta, notes, weight_grams, cost_price_snapshot)
  SELECT v_order_id, (elem->>'product_id')::uuid, (elem->>'quantity')::int, (elem->>'unit_price')::numeric,
    COALESCE((SELECT array_agg(value::uuid) FROM jsonb_array_elements_text(COALESCE(elem->'modifier_ids', '[]'::jsonb)) AS t(value)), ARRAY[]::uuid[]),
    (elem->>'modifier_price_delta')::numeric, elem->>'notes', NULLIF((elem->>'weight_grams')::text, '')::integer,
    (elem->>'cost_price_snapshot')::numeric
  FROM jsonb_array_elements(v_derived_items) AS elem;

  IF p_legs IS NULL THEN
    v_result := process_payment_atomic(p_tab_id := v_tab_id, p_staff_id := p_staff_id, p_amount := p_amount,
      p_method := p_method, p_idempotency_key := p_idempotency_key, p_tendered_amount := p_tendered_amount,
      p_reference_number := p_reference_number, p_discount_scope := NULL, p_discount_type := NULL,
      p_discount_value := NULL, p_discount_amount := NULL);
  ELSE
    v_result := process_split_payment_atomic(p_tab_id := v_tab_id, p_staff_id := p_staff_id, p_legs := p_legs,
      p_expected_total := p_expected_total, p_idempotency_key := p_idempotency_key, p_discount_scope := NULL,
      p_discount_type := NULL, p_discount_value := NULL, p_discount_amount := NULL);
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

-- ============================================================================
-- 3. process_split_payment_atomic — same signature, stop writing tip_amount
-- ============================================================================

CREATE OR REPLACE FUNCTION public.process_split_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_legs jsonb, p_expected_total numeric, p_idempotency_key text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_leg_count       INT;
  v_existing_id     UUID;
  v_existing_group  UUID;
  v_payment_ids     UUID[];
  v_tab_status      tab_status;
  v_rappi_tab       TEXT;
  v_current         INT;
  v_legs_sum        NUMERIC;
  v_group_id        UUID;
  v_i               INT;
  v_leg             JSONB;
  v_method          TEXT;
  v_leg_amount      NUMERIC;
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
      IF ROUND(v_leg_tendered, 2) < ROUND(v_leg_amount, 2) THEN
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
$function$;

-- ============================================================================
-- 4. process_refund — stop writing tip_amount on the negative refund row
-- ============================================================================

CREATE OR REPLACE FUNCTION public.process_refund(p_original_payment_id uuid, p_items jsonb, p_reason text, p_manager_pin text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- ============================================================================
-- 5. close_caja_session — cash reconciliation from amount only
-- ============================================================================

CREATE OR REPLACE FUNCTION public.close_caja_session(p_caja_id uuid, p_closed_by uuid, p_closing_cash numeric, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_open_tab_count INT;
  v_caller_role TEXT;
  v_before_row jsonb;
  v_after_row jsonb;
  v_opening_cash NUMERIC(12,2);
  v_cash_sales NUMERIC(12,2);
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid();
  IF v_caller_role NOT IN ('manager', 'admin') THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'PERMISSION_DENIED',
      'message', 'Only managers and admins can close the caja.'
    ));
  END IF;

  IF p_closed_by IS DISTINCT FROM auth.uid() THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'PERMISSION_DENIED',
      'message', 'Caja close must be attributed to the authenticated caller.'
    ));
  END IF;

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

  SELECT to_jsonb(c), c.opening_cash
  INTO v_before_row, v_opening_cash
  FROM caja_sessions c
  WHERE c.id = p_caja_id;

  UPDATE caja_sessions
  SET
    closed_at = now(),
    closed_by = auth.uid(),
    closing_cash = p_closing_cash,
    notes = COALESCE(p_notes, notes),
    status = 'closed',
    version = version + 1
  WHERE id = p_caja_id AND status = 'open';

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', json_build_object(
      'code', 'NOT_FOUND',
      'message', 'Caja session not found or already closed.'
    ));
  END IF;

  SELECT COALESCE(SUM(p.amount), 0)
  INTO v_cash_sales
  FROM payments p
  JOIN tabs t ON t.id = p.tab_id
  WHERE t.caja_session_id = p_caja_id
    AND t.is_deleted = FALSE
    AND p.method = 'cash'
    AND p.is_deleted = FALSE
    AND p.status IS DISTINCT FROM 'reopened_void';

  SELECT to_jsonb(c) INTO v_after_row FROM caja_sessions c WHERE c.id = p_caja_id;
  PERFORM record_audit('caja.close', 'caja_session', p_caja_id, v_before_row, v_after_row, 'rpc');

  RETURN json_build_object(
    'ok', true,
    'cashReconciliation', json_build_object(
      'openingCash', v_opening_cash,
      'cashSales', v_cash_sales,
      'expectedCash', v_opening_cash + v_cash_sales,
      'closingCash', p_closing_cash,
      'variance', p_closing_cash - (v_opening_cash + v_cash_sales)
    )
  );
END;
$function$;

-- ============================================================================
-- 6. get_caja_report — revenue aggregates from amount only
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_caja_report(p_caja_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
    COALESCE(SUM(amount), 0),
    COALESCE(SUM(CASE WHEN method = 'cash'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'card'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'rappi' THEN amount ELSE 0 END), 0)
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

  -- Top 10 products by quantity sold. Phase 25 Plan 04: LEFT JOIN categories
  -- adds the category dimension (a product with a null category_id still
  -- appears, with a null categoryName) and every alias is camelCased to
  -- match CajaReportTopProductSchema. LIMIT 10 unchanged (Pitfall 3).
  SELECT json_agg(row_to_json(t)) INTO v_top_products
  FROM (
    SELECT
      p.name            AS "productName",
      p.category_id     AS "categoryId",
      c.name            AS "categoryName",
      SUM(oi.quantity)  AS quantity,
      SUM(oi.quantity * oi.unit_price) AS revenue
    FROM order_items oi
    JOIN orders o    ON o.id = oi.order_id
    JOIN products p  ON p.id = oi.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE o.tab_id = ANY(v_tab_ids)
      AND o.status <> 'voided'
      AND o.is_deleted = FALSE
      AND oi.is_deleted = FALSE
    GROUP BY p.id, p.name, p.category_id, c.name
    ORDER BY quantity DESC
    LIMIT 10
  ) t;

  -- Staff performance summary. Phase 23: exclude reopened_void rows from
  -- the per-staff sales total, same reasoning as the top-level aggregate.
  -- Phase 25 Plan 04: every alias camelCased to match CajaReportStaffSchema.
  SELECT json_agg(row_to_json(s)) INTO v_staff_summary
  FROM (
    SELECT
      pr.id             AS "staffId",
      pr.name           AS "staffName",
      COUNT(DISTINCT o.id) AS "orderCount",
      COALESCE(SUM(pay.amount), 0) AS "salesTotal"
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
    ORDER BY "salesTotal" DESC
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
$function$;

-- ============================================================================
-- 7. get_payment_methods_report — drop tipAmount column from both grains
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_payment_methods_report(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    -- Grain 1: per-caja-session + method
    SELECT
      tb.caja_session_id AS "cajaSessionId",
      p.method AS method,
      COUNT(*) AS "legCount",
      COALESCE(SUM(p.amount), 0) AS "grossAmount",
      FALSE AS "isRollup"
    FROM payments p
    JOIN tabs tb ON tb.id = p.tab_id
    WHERE p.is_deleted = FALSE
      AND p.status IS DISTINCT FROM 'reopened_void'
      AND p.is_refund = FALSE
      AND p.processed_at BETWEEN p_from AND p_to
    GROUP BY tb.caja_session_id, p.method

    UNION ALL

    -- Grain 2: day-level rollup per method (cajaSessionId = NULL, pinned to
    -- the table bottom by the client via isRollup)
    SELECT
      NULL::uuid AS "cajaSessionId",
      p.method AS method,
      COUNT(*) AS "legCount",
      COALESCE(SUM(p.amount), 0) AS "grossAmount",
      TRUE AS "isRollup"
    FROM payments p
    WHERE p.is_deleted = FALSE
      AND p.status IS DISTINCT FROM 'reopened_void'
      AND p.is_refund = FALSE
      AND p.processed_at BETWEEN p_from AND p_to
    GROUP BY p.method
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $function$;

-- ============================================================================
-- 8. payments.tip_amount — drop the column last, once nothing reads/writes it
-- ============================================================================

ALTER TABLE public.payments DROP COLUMN IF EXISTS tip_amount;
