CREATE OR REPLACE FUNCTION public.process_direct_sale_atomic(
  p_staff_id uuid,
  p_shift_id uuid,
  p_caja_session_id uuid,
  p_items jsonb,
  p_idempotency_key text,
  p_method text DEFAULT NULL,
  p_amount numeric DEFAULT NULL,
  p_tip_amount numeric DEFAULT NULL,
  p_tendered_amount numeric DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_legs jsonb DEFAULT NULL,
  p_expected_total numeric DEFAULT NULL,
  p_discount_scope text DEFAULT NULL,
  p_discount_type text DEFAULT NULL,
  p_discount_value numeric DEFAULT NULL,
  p_discount_amount numeric DEFAULT NULL,
  p_customer_name text DEFAULT 'Walk-in'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_payment_id uuid;
  v_existing_tab_id uuid;
  v_catalog_price numeric;
  v_elem jsonb;
  v_tab_id uuid;
  v_order_id uuid;
  v_result jsonb;
BEGIN
  SELECT id, tab_id INTO v_existing_payment_id, v_existing_tab_id
  FROM payments
  WHERE idempotency_key = p_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'tabId', v_existing_tab_id,
      'paymentId', v_existing_payment_id
    );
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ITEMS', 'message', 'At least one item is required');
  END IF;

  IF (p_method IN ('cash', 'card')) = (p_legs IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Provide one payment method or split legs');
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT base_price INTO v_catalog_price
    FROM products
    WHERE id = (v_elem->>'product_id')::uuid;

    IF v_catalog_price IS NULL
      OR abs((v_elem->>'unit_price')::numeric - v_catalog_price) > 0.01 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'PRICE_MISMATCH',
        'message', 'Item price does not match catalog'
      );
    END IF;
  END LOOP;

  INSERT INTO tabs (customer_name, staff_id, shift_id, caja_session_id, status)
  VALUES (p_customer_name, p_staff_id, p_shift_id, p_caja_session_id, 'open')
  RETURNING id INTO v_tab_id;

  INSERT INTO orders (tab_id, staff_id, status, notes)
  VALUES (v_tab_id, p_staff_id, 'pending', NULL)
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (
    order_id,
    product_id,
    quantity,
    unit_price,
    modifier_ids,
    modifier_price_delta,
    notes
  )
  SELECT
    v_order_id,
    (elem->>'product_id')::uuid,
    COALESCE((elem->>'quantity')::int, 1),
    (elem->>'unit_price')::numeric,
    COALESCE(
      (SELECT array_agg(value::uuid) FROM jsonb_array_elements_text(COALESCE(elem->'modifier_ids', '[]'::jsonb)) AS t(value)),
      ARRAY[]::uuid[]
    ),
    COALESCE((elem->>'modifier_price_delta')::numeric, 0),
    NULLIF(elem->>'notes', '')
  FROM jsonb_array_elements(p_items) AS elem;

  IF p_legs IS NULL THEN
    v_result := process_payment_atomic(
      p_tab_id := v_tab_id,
      p_staff_id := p_staff_id,
      p_amount := p_amount,
      p_tip_amount := p_tip_amount,
      p_method := p_method,
      p_idempotency_key := p_idempotency_key,
      p_tendered_amount := p_tendered_amount,
      p_reference_number := p_reference_number,
      p_discount_scope := p_discount_scope,
      p_discount_type := p_discount_type,
      p_discount_value := p_discount_value,
      p_discount_amount := p_discount_amount
    );
  ELSE
    v_result := process_split_payment_atomic(
      p_tab_id := v_tab_id,
      p_staff_id := p_staff_id,
      p_legs := p_legs,
      p_expected_total := p_expected_total,
      p_idempotency_key := p_idempotency_key,
      p_discount_scope := p_discount_scope,
      p_discount_type := p_discount_type,
      p_discount_value := p_discount_value,
      p_discount_amount := p_discount_amount
    );
  END IF;

  IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'DIRECT_SALE_PAYMENT_FAILED: %', v_result->>'message';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tabId', v_tab_id,
    'paymentId', v_result->>'paymentId',
    'paymentIds', v_result->'paymentIds',
    'idempotent', COALESCE((v_result->>'idempotent')::boolean, false)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'code', 'DIRECT_SALE_FAILED', 'message', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.process_direct_sale_atomic(
  uuid, uuid, uuid, jsonb, text, text, numeric, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_direct_sale_atomic(
  uuid, uuid, uuid, jsonb, text, text, numeric, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text
) TO service_role;
