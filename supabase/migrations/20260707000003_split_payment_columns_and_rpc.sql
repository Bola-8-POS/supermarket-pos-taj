-- =============================================================================
-- Phase 18 Plan 02: Split payment columns + atomic multi-leg RPC (D-08/D-10)
--
-- Adds the backend heart of split payment (multi-method checkout, up to 4
-- legs per tab close):
--
--   1. payments.payment_group_id (UUID) + payments.split_index (SMALLINT,
--      CHECK 0-3) — tags which rows belong to one atomic split checkout.
--      Both nullable, no backfill (D-11: single-method rows keep working
--      with NULL group/index — 18-RESEARCH.md discretion resolution).
--
--   2. process_split_payment_atomic(...) — a new PL/pgSQL RPC (added by
--      Task 2 below) that inserts 1-4 payment rows in ONE transaction,
--      validates the leg sum against the client-computed total (D-05,
--      ±0.01), and closes the tab all-or-nothing (D-08).
--
-- D-10 note: CONTEXT.md's instruction to "drop the UNIQUE(tab_id) constraint"
-- is STALE — that constraint (payments_tab_id_key) was already dropped by
-- 20260424000005_payments_constraint.sql (S1-05). This migration does NOT
-- touch it.
--
-- The migration is NOT pushed by this plan — the BLOCKING push happens in
-- Plan 18-03.
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. payments.payment_group_id + payments.split_index (SC-1)
-- -----------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_group_id UUID,
  ADD COLUMN IF NOT EXISTS split_index SMALLINT CHECK (split_index >= 0 AND split_index <= 3);

CREATE INDEX IF NOT EXISTS idx_payments_payment_group_id
  ON payments(payment_group_id) WHERE payment_group_id IS NOT NULL;

-- Prevents duplicate split_index within one group (defense in depth —
-- process_split_payment_atomic already assigns indices 0..N-1 deterministically).
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_group_split_unique
  ON payments(payment_group_id, split_index) WHERE payment_group_id IS NOT NULL;

-- -----------------------------------------------------------------------
-- 2. process_split_payment_atomic — atomic multi-leg RPC (SC-2)
--
-- Composes three proven precedents:
--   - split_tab_by_amount's jsonb-array FOR loop (20260427000002)
--   - process_payment_atomic's P0V01/P0V02 version guard (20260512000002)
--   - process_payment_atomic's multi-payment tab-close logic
--     (v_owed/v_paid_line, 20260512000002)
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

  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0) INTO v_paid_line
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false;

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
-- 3. get_payments_split_columns — SC-1 introspection helper (Rule 2/3
--    deviation, see file-header comment). Read-only, scoped to exactly the
--    2 columns this migration adds.
--
--    Supabase's PostgREST config only exposes the `public`/`graphql_public`
--    schemas (see supabase/config.toml [api].schemas) — `information_schema`
--    is NOT queryable directly via `.from(...)` over the REST API. The
--    SC-1 live-integration test (Task 3) needs to assert
--    payment_group_id/split_index column metadata (data_type, is_nullable)
--    from a live remote DB, so this wrapper re-exposes the two relevant
--    information_schema.columns rows through a normal RPC call.
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_payments_split_columns()
RETURNS TABLE(column_name TEXT, data_type TEXT, is_nullable TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT c.column_name, c.data_type, c.is_nullable
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'payments'
    AND c.column_name IN ('payment_group_id', 'split_index');
$$;

REVOKE ALL ON FUNCTION public.get_payments_split_columns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payments_split_columns() TO service_role;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.get_payments_split_columns() FROM service_role;
-- DROP FUNCTION IF EXISTS public.get_payments_split_columns();
-- REVOKE EXECUTE ON FUNCTION public.process_split_payment_atomic(UUID, UUID, JSONB, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT) FROM service_role;
-- DROP FUNCTION IF EXISTS public.process_split_payment_atomic(UUID, UUID, JSONB, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT);
-- DROP INDEX IF EXISTS idx_payments_group_split_unique;
-- DROP INDEX IF EXISTS idx_payments_payment_group_id;
-- ALTER TABLE payments DROP COLUMN IF EXISTS split_index;
-- ALTER TABLE payments DROP COLUMN IF EXISTS payment_group_id;
-- COMMIT;
-- =============================================================================
