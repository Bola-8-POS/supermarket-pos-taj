-- Payment processing: Rappi enum value, tab linkage, payment audit columns, atomic RPC

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'rappi';

ALTER TABLE tabs
  ADD COLUMN IF NOT EXISTS rappi_order_id VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_tabs_rappi_order_id ON tabs (rappi_order_id) WHERE rappi_order_id IS NOT NULL;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS tendered_amount NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS reference_number VARCHAR(64),
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

UPDATE payments
SET idempotency_key = 'legacy_' || id::text
WHERE idempotency_key IS NULL;

ALTER TABLE payments
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency_key ON payments (idempotency_key);

-- Atomic payment: validates tab + pool + amounts, idempotent replay, insert payment + close tab
CREATE OR REPLACE FUNCTION public.process_payment_atomic(
  p_tab_id UUID,
  p_staff_id UUID,
  p_amount NUMERIC,
  p_tip_amount NUMERIC,
  p_method TEXT,
  p_idempotency_key TEXT,
  p_tendered_amount NUMERIC DEFAULT NULL,
  p_reference_number TEXT DEFAULT NULL,
  p_rappi_order_id TEXT DEFAULT NULL
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
  v_items NUMERIC;
  v_pool NUMERIC;
  v_expected NUMERIC;
  v_total NUMERIC;
  v_payment_id UUID;
  v_method payment_method;
  v_open_pool INT;
  v_tab_updated INT;
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

  SELECT COALESCE(SUM((oi.unit_price + oi.modifier_price_delta) * oi.quantity::NUMERIC), 0)
  INTO v_items
  FROM order_items oi
  INNER JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND o.status IS DISTINCT FROM 'voided'::order_status;

  SELECT COALESCE(SUM(ps.total_charge), 0)
  INTO v_pool
  FROM pool_sessions ps
  WHERE ps.tab_id = p_tab_id AND ps.stopped_at IS NOT NULL;

  v_expected := ROUND(v_items + v_pool, 2);

  IF ROUND(p_amount, 2) IS DISTINCT FROM v_expected THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'AMOUNT_MISMATCH',
      'message', 'Amount does not match tab subtotal'
    );
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
    idempotency_key
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
    p_idempotency_key
  )
  RETURNING id INTO v_payment_id;

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
    SELECT id INTO v_existing_id FROM payments WHERE tab_id = p_tab_id LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'paymentId', v_existing_id);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'message', 'Duplicate payment');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', 'Payment failed');
END;
$$;

REVOKE ALL ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO service_role;
