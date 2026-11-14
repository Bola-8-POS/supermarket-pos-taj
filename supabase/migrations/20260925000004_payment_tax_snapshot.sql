-- Every payment row keeps the tax rate and amount that applied at sale
-- time, so a reprint after the billing setting changes still matches the
-- original print to the cent.
--
-- 1. payments.tax_amount / tax_rate_percent / tax_inclusive.
-- 2. payment_tax_amount(amount, rate, inclusive): pure arithmetic, mirrors
--    decomposeTax exactly; NULL in (STRICT) -> NULL out.
-- 3. billing_tax_settings(): the one read of settings.billing with its
--    defaults, reused by every writer below.
-- 4. process_payment_atomic / process_split_payment_atomic: snapshot the
--    tax at insert time.
-- 5. process_refund: the refund row copies the original payment's rate when
--    present, else the current setting; process_direct_sale_atomic is
--    untouched (it delegates to the two RPCs above).

-- ---------------------------------------------------------------------------
-- 1. payments tax columns
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS tax_amount numeric(10,2) NULL,
  ADD COLUMN IF NOT EXISTS tax_rate_percent numeric(5,2) NULL,
  ADD COLUMN IF NOT EXISTS tax_inclusive boolean NULL;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_tax_rate_range;
ALTER TABLE payments
  ADD CONSTRAINT payments_tax_rate_range
    CHECK (tax_rate_percent IS NULL OR (tax_rate_percent >= 0 AND tax_rate_percent <= 100));

-- ---------------------------------------------------------------------------
-- 2. payment_tax_amount — mirrors decomposeTax (supabase/functions/_shared/tax.ts).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payment_tax_amount(p_amount numeric, p_rate_percent numeric, p_inclusive boolean)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN p_inclusive THEN ROUND(p_amount - ROUND(p_amount / (1 + p_rate_percent / 100.0), 2), 2)
    ELSE ROUND(p_amount * p_rate_percent / (100 + p_rate_percent), 2)
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.payment_tax_amount(numeric, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payment_tax_amount(numeric, numeric, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. billing_tax_settings — the one read of settings.billing with defaults.
-- No UNION ALL / LIMIT 1 (no defined order); a single scalar subquery per field.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_tax_settings(OUT rate_percent numeric, OUT inclusive boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Rounded to match tax_rate_percent's numeric(5,2) storage, so a rate with
  -- more than two decimal places still decomposes the same way on the
  -- original print and on every later reprint.
  SELECT
    ROUND(COALESCE((SELECT (value->>'taxRatePercent')::numeric FROM settings WHERE key = 'billing'), 16), 2),
    COALESCE((SELECT (value->>'taxInclusive')::boolean FROM settings WHERE key = 'billing'), true);
$$;

REVOKE EXECUTE ON FUNCTION public.billing_tax_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_tax_settings() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. process_payment_atomic — snapshots tax_amount/tax_rate_percent/tax_inclusive.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_amount numeric, p_method text, p_idempotency_key text, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_rappi_order_id text DEFAULT NULL::text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer, p_customer_phone text DEFAULT NULL::text, p_manager_override boolean DEFAULT false, p_approval_id uuid DEFAULT NULL::uuid, p_approver_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
  v_tax_rate numeric;
  v_tax_inclusive boolean;
BEGIN
  -- Phase 27 gap-closure code review (CR-01/CR-02): coalesce a stray SQL NULL
  -- to false so a caller that omits the parameter (or passes NULL explicitly,
  -- overriding the DEFAULT) can never silently skip both the 'IF
  -- p_manager_override' PIN-verification branch AND the 'IF NOT
  -- p_manager_override' DISCOUNT_REQUIRES_MANAGER guard below -- NULL is
  -- neither TRUE nor FALSE in PL/pgSQL, so both branches would otherwise be
  -- skipped. Defense-in-depth: all three RPCs grant EXECUTE to 'authenticated',
  -- so a caller can invoke them directly via PostgREST, skipping the edge
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
  --      (integration tests, future edge functions) are already trusted to
  --      run without row-level security; this mirrors that trust level rather than adding a
  --      new distinct one.
  -- A regular authenticated staff JWT satisfies neither, so the direct-call
  -- path is closed.
  IF p_method = 'bank_transfer'
     AND current_setting('app.bank_transfer_checkout_context', true) IS DISTINCT FROM 'true'
     AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Bank transfer payments can only be marked at checkout time');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_staff_id AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Staff not found or inactive');
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

  -- Whenever a manager override is claimed, resolve the APPROVING staff
  -- member from the approval ticket (and the approver's id when the client sends
  -- it), never from the caller's own p_staff_id. When process_direct_sale_atomic
  -- delegates here it has already resolved the approver and hands it down
  -- through a transaction-local setting, so it is not checked twice.
  IF p_manager_override THEN
    v_manager_staff_id := NULLIF(current_setting('app.manager_approver_id', true), '')::uuid;
    IF v_manager_staff_id IS NULL THEN
      v_approval := resolve_manager_approval(p_approval_id, p_approver_id, 'apply_custom_discount', p_staff_id);
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

  SELECT rate_percent, inclusive INTO v_tax_rate, v_tax_inclusive FROM billing_tax_settings();

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
    approved_by,
    tax_amount,
    tax_rate_percent,
    tax_inclusive
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
    v_manager_staff_id,
    payment_tax_amount(v_total, v_tax_rate, v_tax_inclusive),
    v_tax_rate,
    v_tax_inclusive
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

-- ---------------------------------------------------------------------------
-- 4 (cont.). process_split_payment_atomic — same snapshot, per leg.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_split_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_legs jsonb, p_expected_total numeric, p_idempotency_key text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer, p_manager_override boolean DEFAULT false, p_approval_id uuid DEFAULT NULL::uuid, p_approver_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
  v_tax_rate numeric;
  v_tax_inclusive boolean;
BEGIN
  -- Phase 27 gap-closure code review (CR-01/CR-02): coalesce a stray SQL NULL
  -- to false so a caller that omits the parameter (or passes NULL explicitly,
  -- overriding the DEFAULT) can never silently skip both the 'IF
  -- p_manager_override' PIN-verification branch AND the 'IF NOT
  -- p_manager_override' DISCOUNT_REQUIRES_MANAGER guard below -- NULL is
  -- neither TRUE nor FALSE in PL/pgSQL, so both branches would otherwise be
  -- skipped. Defense-in-depth: all three RPCs grant EXECUTE to 'authenticated',
  -- so a caller can invoke them directly via PostgREST, skipping the edge
  -- function's own '?? false' coalesce entirely.
  p_manager_override := COALESCE(p_manager_override, false);

  -- 1. FORBIDDEN guard
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_staff_id AND is_active = true) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Staff not found or inactive');
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

  -- Whenever a manager override is claimed, resolve the APPROVING staff
  -- member from the approval ticket (and the approver's id when the client sends
  -- it), never from the caller's own p_staff_id. When process_direct_sale_atomic
  -- delegates here it has already resolved the approver and hands it down
  -- through a transaction-local setting, so it is not checked twice.
  IF p_manager_override THEN
    v_manager_staff_id := NULLIF(current_setting('app.manager_approver_id', true), '')::uuid;
    IF v_manager_staff_id IS NULL THEN
      v_approval := resolve_manager_approval(p_approval_id, p_approver_id, 'apply_custom_discount', p_staff_id);
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

  SELECT rate_percent, inclusive INTO v_tax_rate, v_tax_inclusive FROM billing_tax_settings();

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
      approved_by,
      tax_amount,
      tax_rate_percent,
      tax_inclusive
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
      v_manager_staff_id,
      payment_tax_amount(ROUND(v_leg_amount, 2), v_tax_rate, v_tax_inclusive),
      v_tax_rate,
      v_tax_inclusive
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

-- ---------------------------------------------------------------------------
-- 5. process_refund — same six-argument body as the previous migration, plus
--    the tax snapshot: rate/inclusive copied from the original payment row
--    when present, else the current setting; tax_amount from the (negative)
--    refund total.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_refund(
  p_original_payment_id uuid,
  p_items jsonb,
  p_reason text,
  p_approval_id uuid DEFAULT NULL::uuid,
  p_approver_id uuid DEFAULT NULL::uuid,
  p_caja_session_id uuid DEFAULT NULL::uuid
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
BEGIN
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

  RETURN v_refund_id;
END;
$function$;

-- 6. process_direct_sale_atomic is untouched: it delegates to the two RPCs
--    above, which now snapshot from the same settings row it validated
--    against.
