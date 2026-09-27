-- Phase 27 gap-closure: defense-in-depth against a stray SQL NULL for
-- p_manager_override in process_payment_atomic, process_split_payment_atomic,
-- and process_direct_sale_atomic.
--
-- CR-01/CR-02 (Phase 27 code review, 2026-09-03) found that
-- process-payment/index.ts and process-split-payment/index.ts sent an
-- explicit SQL NULL (`?? null`) instead of `false` for p_manager_override
-- whenever a caller omitted the field — which silently disabled BOTH the
-- 'IF p_manager_override THEN' PIN-verification branch AND the
-- 'IF NOT p_manager_override THEN' DISCOUNT_REQUIRES_MANAGER rejection,
-- since NULL is neither TRUE nor FALSE in PL/pgSQL. That edge-function-level
-- bug is fixed separately (process-payment/index.ts, process-split-payment/
-- index.ts now use `?? false`), but all three RPCs additionally grant EXECUTE
-- to `authenticated` (confirmed via information_schema.routine_privileges),
-- so any logged-in staff member can call them directly via PostgREST,
-- bypassing the edge function's coalesce entirely. This migration adds
-- `p_manager_override := COALESCE(p_manager_override, false);` as the first
-- statement in all three function bodies so a stray NULL — from this or any
-- future caller — can never again silently skip the discount-authorization
-- check. Pure body change; parameter list is unchanged from
-- 20260903091500_process_payment_manager_override_wiring.sql, so no
-- DROP FUNCTION is required (CREATE OR REPLACE FUNCTION with an identical
-- signature replaces the body in place).

CREATE OR REPLACE FUNCTION public.process_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_amount numeric, p_method text, p_idempotency_key text, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_rappi_order_id text DEFAULT NULL::text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer, p_customer_phone text DEFAULT NULL::text, p_manager_override boolean DEFAULT false, p_manager_pin text DEFAULT NULL::text)
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
  v_discount_recorded NUMERIC;
  v_payment_row jsonb;
  v_current INT;
  v_transfer_code TEXT;
  -- Phase 27 Plan 09 (G-27-13): resolved from p_manager_pin, independent of p_staff_id.
  v_manager_staff_id uuid;
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

  -- Phase 27 Plan 09 (G-27-13): whenever a manager override is claimed,
  -- independently re-derive the AUTHORIZING staff from the entered PIN itself
  -- (p_manager_pin), never from the caller's own p_staff_id. Mirrors
  -- process_direct_sale_atomic's re-verification exactly (27-08).
  IF p_manager_override THEN
    SELECT p.id INTO v_manager_staff_id
    FROM profiles p JOIN role_permissions rp ON rp.role = p.role
    WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'apply_custom_discount';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Not authorized to apply a manager override');
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
$function$

;
CREATE OR REPLACE FUNCTION public.process_split_payment_atomic(p_tab_id uuid, p_staff_id uuid, p_legs jsonb, p_expected_total numeric, p_idempotency_key text, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_expected_version integer DEFAULT NULL::integer, p_manager_override boolean DEFAULT false, p_manager_pin text DEFAULT NULL::text)
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
  v_discount_recorded NUMERIC;
  v_tab_updated     INT;
  -- Phase 27 Plan 09 (G-27-13): resolved from p_manager_pin, independent of p_staff_id.
  v_manager_staff_id uuid;
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

  -- Phase 27 Plan 09 (G-27-13): whenever a manager override is claimed,
  -- independently re-derive the AUTHORIZING staff from the entered PIN itself
  -- (p_manager_pin), never from the caller's own p_staff_id. Mirrors
  -- process_direct_sale_atomic's re-verification exactly (27-08).
  IF p_manager_override THEN
    SELECT p.id INTO v_manager_staff_id
    FROM profiles p JOIN role_permissions rp ON rp.role = p.role
    WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'apply_custom_discount';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Not authorized to apply a manager override');
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
$function$

;
CREATE OR REPLACE FUNCTION public.process_direct_sale_atomic(p_staff_id uuid, p_shift_id uuid, p_caja_session_id uuid, p_items jsonb, p_idempotency_key text, p_method text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_legs jsonb DEFAULT NULL::jsonb, p_expected_total numeric DEFAULT NULL::numeric, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_customer_name text DEFAULT 'Walk-in'::text, p_customer_phone text DEFAULT NULL::text, p_manager_override boolean DEFAULT false, p_manager_pin text DEFAULT NULL::text)
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

  -- Phase 27 (T-27-02), re-keyed in Plan 08 (G-27-13): whenever a manager
  -- override is claimed — for the ad-hoc discount OR the below-cost
  -- floor-guard bypass evaluated later in the per-item loop — independently
  -- re-derive the AUTHORIZING staff from the entered PIN itself
  -- (p_manager_pin), never from the caller's own p_staff_id. The client's
  -- ManagerPinDialog is UX-only; this is the actual authorization boundary
  -- (mirrors process_refund's two-layer pattern). One PIN entry authorizes
  -- the whole checkout attempt (must_have backstop truth).
  IF p_manager_override THEN
    SELECT p.id INTO v_manager_staff_id
    FROM profiles p JOIN role_permissions rp ON rp.role = p.role
    WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'apply_custom_discount';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Not authorized to apply a manager override');
    END IF;
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

    -- Best-price-wins candidate pool (PROMO-04/D-05): every active
    -- product-scoped OR category-scoped promotion matching this line item is
    -- an independent candidate, never merged/deduped (must_have truth). The
    -- single largest discount amount wins; on an exact tie the most
    -- recently created promotion wins (D-06). Fixed-type is capped at the
    -- line's expected price via LEAST; percent-type is inherently capped
    -- since discount_value <= 100 (schema CHECK).
    SELECT p.id, p.discount_value, p.created_at,
      (CASE WHEN p.discount_type = 'percent'
            THEN ROUND(v_expected_price * p.discount_value / 100.0, 2)
            ELSE LEAST(p.discount_value, v_expected_price)
       END) AS amount
    INTO v_cand_id, v_cand_rate, v_cand_created_at, v_cand_amount
    FROM promotions p
    WHERE p.active
      AND now() BETWEEN p.starts_at AND p.ends_at
      AND (p.product_id = (v_elem->>'product_id')::uuid OR p.category_id = v_category_id)
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
$function$

;
