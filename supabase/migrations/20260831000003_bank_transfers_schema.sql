-- Phase 23-01: bank_transfers table, Luhn reference-code functions,
-- process_payment_atomic/process_direct_sale_atomic extended to accept
-- method='bank_transfer', and the two manager+-gated reconciliation RPCs
-- (confirm_transfer_payment / dispute_transfer_payment).
--
-- Applied AFTER 20260831000002_bank_transfer_payment_method.sql so the
-- 'bank_transfer' enum value already exists in this transaction (Pitfall 4).
--
-- No DOWN script (project convention — Supabase Cloud has no automated
-- rollback mechanism, see CLAUDE.md).

-- ============================================================================
-- 1. bank_transfers table (sibling to `refunds`, 1:1 with `payments`)
-- ============================================================================

CREATE TABLE public.bank_transfers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid        NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'disputed')),
  customer_phone  text,
  created_by      uuid        NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_by    uuid        REFERENCES profiles(id) ON DELETE RESTRICT,
  confirmed_at    timestamptz,
  disputed_by     uuid        REFERENCES profiles(id) ON DELETE RESTRICT,
  disputed_at     timestamptz,
  dispute_reason  text
);

CREATE INDEX idx_bank_transfers_status ON bank_transfers(status);

ALTER TABLE bank_transfers ENABLE ROW LEVEL SECURITY;

-- Every write happens exclusively through the SECURITY DEFINER RPCs below
-- (process_payment_atomic for INSERT, confirm_transfer_payment/
-- dispute_transfer_payment for UPDATE) which run as the function owner and
-- therefore bypass RLS. Deliberately no INSERT/UPDATE/DELETE policy here —
-- RLS default-denies any direct client write.
CREATE POLICY "bank_transfers_select_authenticated" ON bank_transfers
  FOR SELECT TO authenticated
  USING (true);

-- ============================================================================
-- 2. Luhn reference-code functions — ported verbatim from
--    .planning/spikes/003-reference-code-design/reference-code.cjs
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bank_transfer_luhn_check_digit(p_payload text)
 RETURNS int
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sum int := 0;
  v_digit int;
  v_len int := length(p_payload);
  i int;
BEGIN
  FOR i IN 0..(v_len - 1) LOOP
    v_digit := substr(p_payload, v_len - i, 1)::int;
    IF i % 2 = 0 THEN
      v_digit := v_digit * 2;
      IF v_digit > 9 THEN
        v_digit := v_digit - 9;
      END IF;
    END IF;
    v_sum := v_sum + v_digit;
  END LOOP;
  RETURN (10 - (v_sum % 10)) % 10;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bank_transfer_is_valid_code(p_code text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[0-9]{7}$' THEN
    RETURN false;
  END IF;
  RETURN bank_transfer_luhn_check_digit(substr(p_code, 1, 6)) = substr(p_code, 7, 1)::int;
END;
$function$;

-- Uniqueness scope is deliberately narrow (D-02): only among currently-pending
-- transfers, not globally/permanently unique — a code from an already
-- confirmed or disputed transfer is free to be reused.
CREATE OR REPLACE FUNCTION public.bank_transfer_generate_unique_code()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payload  text;
  v_code     text;
  v_attempts int := 0;
BEGIN
  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > 1000 THEN
      RAISE EXCEPTION 'BANK_TRANSFER_CODE_SPACE_EXHAUSTED: pending-code space exhausted, widen payload length';
    END IF;
    v_payload := lpad(floor(random() * 1000000)::int::text, 6, '0');
    v_code := v_payload || bank_transfer_luhn_check_digit(v_payload)::text;
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM bank_transfers bt
      JOIN payments p ON p.id = bt.payment_id
      WHERE bt.status = 'pending' AND p.reference_number = v_code
    );
  END LOOP;
  RETURN v_code;
END;
$function$;

-- ============================================================================
-- 3. process_payment_atomic — accept method='bank_transfer', generate the
--    server-side reference code, create the pending bank_transfers row.
--    Body otherwise identical to 20260828000001_drop_tip_amount.sql.
-- ============================================================================

DROP FUNCTION IF EXISTS public.process_payment_atomic(
  uuid, uuid, numeric, text, text, numeric, text, text, text, text, numeric, numeric, integer
);

CREATE FUNCTION public.process_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_amount numeric, p_method text, p_idempotency_key text, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_rappi_order_id text DEFAULT NULL::text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer, p_customer_phone text DEFAULT NULL::text)
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
  v_transfer_code TEXT;
BEGIN
  IF p_method NOT IN ('cash', 'card', 'rappi', 'bank_transfer') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Payment method must be cash, card, rappi, or bank_transfer');
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
    discount_amount
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

-- ============================================================================
-- 4. process_direct_sale_atomic — accept method='bank_transfer' as a
--    single-leg method, forward p_customer_phone to process_payment_atomic.
--    Body otherwise identical to 20260828000001_drop_tip_amount.sql.
-- ============================================================================

DROP FUNCTION IF EXISTS public.process_direct_sale_atomic(
  uuid, uuid, uuid, jsonb, text, text, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text
);

CREATE FUNCTION public.process_direct_sale_atomic(p_staff_id uuid, p_shift_id uuid, p_caja_session_id uuid, p_items jsonb, p_idempotency_key text, p_method text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_legs jsonb DEFAULT NULL::jsonb, p_expected_total numeric DEFAULT NULL::numeric, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_customer_name text DEFAULT 'Walk-in'::text, p_customer_phone text DEFAULT NULL::text)
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
  IF (p_method IN ('cash', 'card', 'bank_transfer')) = (p_legs IS NOT NULL) THEN
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
    -- WR-03 fix: authorize the one legitimate bank_transfer caller (this
    -- freshly-inserted tab, same transaction) via a transaction-local GUC —
    -- see the matching check in process_payment_atomic.
    IF p_method = 'bank_transfer' THEN
      PERFORM set_config('app.bank_transfer_checkout_context', 'true', true);
    END IF;
    v_result := process_payment_atomic(p_tab_id := v_tab_id, p_staff_id := p_staff_id, p_amount := p_amount,
      p_method := p_method, p_idempotency_key := p_idempotency_key, p_tendered_amount := p_tendered_amount,
      p_reference_number := p_reference_number, p_discount_scope := NULL, p_discount_type := NULL,
      p_discount_value := NULL, p_discount_amount := NULL, p_customer_phone := p_customer_phone);
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
-- 5. confirm_transfer_payment — manager+-gated, mirrors process_refund's
--    exact auth-check + audit shape (D-07).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_transfer_payment(p_payment_id uuid, p_entered_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_staff_id  uuid;
  v_transfer  record;
BEGIN
  SELECT id INTO v_staff_id FROM profiles
  WHERE id = auth.uid()
    AND role IN ('manager', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  SELECT bt.*, p.reference_number INTO v_transfer
  FROM bank_transfers bt
  JOIN payments p ON p.id = bt.payment_id
  WHERE bt.payment_id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no pending bank transfer for payment %', p_payment_id;
  END IF;

  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_PROCESSED: transfer already %', v_transfer.status;
  END IF;

  -- Luhn check strictly BEFORE the equality compare (D-08) — a mistyped code
  -- is rejected as "please re-enter," never silently compared and mismatched.
  IF NOT bank_transfer_is_valid_code(p_entered_code) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: entered code fails check-digit validation';
  END IF;

  IF p_entered_code IS DISTINCT FROM v_transfer.reference_number THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: entered code does not match this sale''s reference code';
  END IF;

  UPDATE bank_transfers
  SET status = 'confirmed', confirmed_by = v_staff_id, confirmed_at = now()
  WHERE payment_id = p_payment_id;

  PERFORM record_audit(
    'payment.transfer_confirmed',
    'payment',
    p_payment_id,
    to_jsonb(v_transfer),
    jsonb_build_object('status', 'confirmed', 'confirmedBy', v_staff_id),
    'rpc'
  );

  RETURN jsonb_build_object('ok', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION confirm_transfer_payment(uuid, text) TO authenticated;

-- ============================================================================
-- 6. dispute_transfer_payment — manager+-gated, same lookup/status guard as
--    confirm_transfer_payment; requires a non-empty reason (D-10).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.dispute_transfer_payment(p_payment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_staff_id  uuid;
  v_transfer  record;
BEGIN
  SELECT id INTO v_staff_id FROM profiles
  WHERE id = auth.uid()
    AND role IN ('manager', 'admin');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  SELECT bt.*, p.reference_number INTO v_transfer
  FROM bank_transfers bt
  JOIN payments p ON p.id = bt.payment_id
  WHERE bt.payment_id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no pending bank transfer for payment %', p_payment_id;
  END IF;

  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_PROCESSED: transfer already %', v_transfer.status;
  END IF;

  IF NULLIF(TRIM(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: dispute reason is required';
  END IF;

  UPDATE bank_transfers
  SET status = 'disputed', disputed_by = v_staff_id, disputed_at = now(), dispute_reason = TRIM(p_reason)
  WHERE payment_id = p_payment_id;

  PERFORM record_audit(
    'payment.transfer_disputed',
    'payment',
    p_payment_id,
    to_jsonb(v_transfer),
    jsonb_build_object('status', 'disputed', 'disputeReason', TRIM(p_reason)),
    'rpc'
  );

  RETURN jsonb_build_object('ok', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION dispute_transfer_payment(uuid, text) TO authenticated;
