-- Add discount columns to payments table and update process_payment_atomic RPC
-- to accept discount parameters and remove the AMOUNT_MISMATCH check (discounts
-- cause the client-provided amount to differ from the raw subtotal).

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS discount_scope TEXT CHECK (discount_scope IN ('all', 'pool_only', 'consumptions_only')),
  ADD COLUMN IF NOT EXISTS discount_type TEXT CHECK (discount_type IN ('percent', 'fixed')),
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2);

-- Drop the old function signature before replacing it with an extended one
-- (PostgreSQL treats functions with different param counts as overloads, so we
-- must explicitly drop the old version to avoid an ambiguous overload set).
DROP FUNCTION IF EXISTS public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT);

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

  -- No AMOUNT_MISMATCH check: the client-provided amount already reflects any
  -- discount applied, so it will differ from the raw subtotal. Accept the
  -- client amount as authoritative.

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

REVOKE ALL ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) TO service_role;
