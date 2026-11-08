-- Phase 2 gap closure (CHK-03, CR-01/CR-02): process_direct_sale_atomic no
-- longer trusts client-supplied monetary or modifier data, and idempotency
-- replay is authorized before it discloses any sale identity.
--
-- CR-01 (financial authority): the previous version persisted the client's
-- unit_price/modifier_price_delta as-is and forwarded the client's p_amount /
-- p_expected_total straight to the generic payment RPCs, whose own "paid"
-- check only compares against SUM(order_items.unit_price * quantity) -- a
-- basis that has no tax and no modifier delta. This redefinition derives an
-- authoritative subtotal (locked, active catalog price + verified
-- product_modifiers/modifiers delta), adds billing tax from settings, and
-- rejects any p_amount / p_expected_total that disagrees with that derived
-- total by more than one cent -- before any row is written. Every direct-sale
-- discount field is rejected outright (DISCOUNT_UNSUPPORTED): Phase 1 dropped
-- the promotions engine, so there is no server-owned discount eligibility
-- source for this RPC to validate against.
--
-- CR-02 (replay authorization): the previous version looked up an existing
-- idempotency key and returned its payment/tab before validating that the
-- caller's Caja session and shift were open, let alone that the caller was
-- the original cashier. This redefinition locks and validates the caller's
-- open Caja and staff-owned open shift FIRST, then binds the idempotency
-- lookup to that same staff/shift/Caja identity: a key that exists under a
-- different identity returns a generic 'IDEMPOTENCY_UNAUTHORIZED' error with
-- no tab/payment identifiers, rather than replaying another cashier's sale.
--
-- Only process_direct_sale_atomic is redefined here. The generic
-- process_payment_atomic / process_split_payment_atomic RPCs (last redefined
-- in 20260810000003_drop_pool_resources.sql) are untouched and continue to
-- own tender/version/Caja-agnostic payment mechanics; this function now
-- guarantees they are only ever called with a server-derived, authoritative
-- amount and NULL discount inputs.

CREATE OR REPLACE FUNCTION public.process_direct_sale_atomic(
  p_staff_id uuid, p_shift_id uuid, p_caja_session_id uuid, p_items jsonb, p_idempotency_key text,
  p_method text DEFAULT NULL, p_amount numeric DEFAULT NULL, p_tip_amount numeric DEFAULT NULL,
  p_tendered_amount numeric DEFAULT NULL, p_reference_number text DEFAULT NULL, p_legs jsonb DEFAULT NULL,
  p_expected_total numeric DEFAULT NULL, p_discount_scope text DEFAULT NULL, p_discount_type text DEFAULT NULL,
  p_discount_value numeric DEFAULT NULL, p_discount_amount numeric DEFAULT NULL, p_customer_name text DEFAULT 'Walk-in'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing_payment_id uuid; v_existing_tab_id uuid; v_existing_group_id uuid; v_existing_payment_ids uuid[];
  v_existing_staff_id uuid; v_existing_shift_id uuid; v_existing_caja_id uuid;
  v_catalog_price numeric; v_expected_price numeric; v_sold_by_weight boolean; v_weight_grams integer;
  v_elem jsonb; v_tab_id uuid; v_order_id uuid; v_result jsonb;
  v_modifier_ids uuid[]; v_modifier_delta numeric; v_line_qty int;
  v_subtotal numeric := 0; v_tax_rate numeric; v_tax numeric; v_derived_total numeric;
  v_derived_items jsonb := '[]'::jsonb;
BEGIN
  -- Validate the caller's Caja and shift BEFORE any idempotency lookup or
  -- replay (CR-02): an unauthorized caller must never reach the replay path.
  PERFORM 1 FROM caja_sessions WHERE id = p_caja_session_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CAJA_CLOSED', 'message', 'Caja session is not open');
  END IF;
  PERFORM 1 FROM shifts WHERE id = p_shift_id AND staff_id = p_staff_id AND clock_out IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SHIFT_NOT_OPEN', 'message', 'Shift is not open or does not belong to this cashier');
  END IF;

  -- Idempotency replay is scoped to the original staff/shift/Caja identity.
  -- A key that exists under a different identity returns a generic
  -- authorization error and discloses no tab/payment identifiers.
  SELECT p.id, p.tab_id, p.payment_group_id, t.staff_id, t.shift_id, t.caja_session_id
  INTO v_existing_payment_id, v_existing_tab_id, v_existing_group_id, v_existing_staff_id, v_existing_shift_id, v_existing_caja_id
  FROM payments p
  JOIN tabs t ON t.id = p.tab_id
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

  -- Phase 1 removed the promotions engine; direct sales have no server-owned
  -- discount eligibility source. Reject any client-supplied discount field
  -- before any row is written (CR-01).
  IF p_discount_scope IS NOT NULL OR p_discount_type IS NOT NULL
     OR p_discount_value IS NOT NULL OR p_discount_amount IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DISCOUNT_UNSUPPORTED', 'message', 'Direct-sale discounts are not supported');
  END IF;

  -- Derive every item's catalog price and modifier total from locked, active
  -- database state -- never from the client-supplied price or delta.
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT base_price, sold_by_weight INTO v_catalog_price, v_sold_by_weight
    FROM products WHERE id = (v_elem->>'product_id')::uuid AND is_active = true FOR UPDATE;
    IF v_catalog_price IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRICE_MISMATCH', 'message', 'Item price does not match catalog');
    END IF;
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

    v_modifier_ids := COALESCE(
      (SELECT array_agg(value::uuid) FROM jsonb_array_elements_text(COALESCE(v_elem->'modifier_ids', '[]'::jsonb)) AS t(value)),
      ARRAY[]::uuid[]
    );
    IF array_length(v_modifier_ids, 1) > 0 THEN
      IF EXISTS (
        SELECT 1 FROM unnest(v_modifier_ids) AS mid
        WHERE NOT EXISTS (
          SELECT 1 FROM product_modifiers pm
          WHERE pm.product_id = (v_elem->>'product_id')::uuid AND pm.modifier_id = mid
        )
      ) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MODIFIER_MISMATCH', 'message', 'Modifier does not belong to this item''s product');
      END IF;
      SELECT COALESCE(SUM(price_delta), 0) INTO v_modifier_delta FROM modifiers WHERE id = ANY(v_modifier_ids);
    ELSE
      v_modifier_delta := 0;
    END IF;

    v_line_qty := COALESCE((v_elem->>'quantity')::int, 1);
    v_subtotal := v_subtotal + (v_expected_price + v_modifier_delta) * v_line_qty;

    v_derived_items := v_derived_items || jsonb_build_object(
      'product_id', v_elem->>'product_id',
      'quantity', v_line_qty,
      'unit_price', v_expected_price,
      'modifier_ids', to_jsonb(v_modifier_ids),
      'modifier_price_delta', v_modifier_delta,
      'notes', NULLIF(v_elem->>'notes', ''),
      'weight_grams', v_weight_grams
    );
  END LOOP;

  v_subtotal := ROUND(v_subtotal, 2);
  SELECT COALESCE((value->>'taxRatePercent')::numeric, 16) INTO v_tax_rate FROM settings WHERE key = 'billing';
  v_tax_rate := COALESCE(v_tax_rate, 16);
  v_tax := ROUND(v_subtotal * (v_tax_rate / 100.0), 2);
  v_derived_total := ROUND(v_subtotal + v_tax, 2);

  -- The single payment amount (or the split's expected total) must agree
  -- with the derived, tax-inclusive sale total within one cent. This is the
  -- authority check that closes CR-01: a card override or any client total
  -- below the real total is rejected here, before any row is written.
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
  -- Persist the server-derived price/modifier-delta from v_derived_items,
  -- never the client-supplied unit_price/modifier_price_delta from p_items.
  INSERT INTO order_items (order_id, product_id, quantity, unit_price, modifier_ids, modifier_price_delta, notes, weight_grams)
  SELECT v_order_id, (elem->>'product_id')::uuid, (elem->>'quantity')::int, (elem->>'unit_price')::numeric,
    COALESCE((SELECT array_agg(value::uuid) FROM jsonb_array_elements_text(COALESCE(elem->'modifier_ids', '[]'::jsonb)) AS t(value)), ARRAY[]::uuid[]),
    (elem->>'modifier_price_delta')::numeric, elem->>'notes', NULLIF((elem->>'weight_grams')::text, '')::integer
  FROM jsonb_array_elements(v_derived_items) AS elem;

  IF p_legs IS NULL THEN
    v_result := process_payment_atomic(p_tab_id := v_tab_id, p_staff_id := p_staff_id, p_amount := p_amount, p_tip_amount := p_tip_amount,
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
$$;

REVOKE ALL ON FUNCTION public.process_direct_sale_atomic(uuid, uuid, uuid, jsonb, text, text, numeric, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_direct_sale_atomic(uuid, uuid, uuid, jsonb, text, text, numeric, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text) TO service_role;
