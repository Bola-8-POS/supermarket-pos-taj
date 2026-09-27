-- =============================================================================
-- Phase 15 Plan 02 — Group A RPC version guards (process_payment_atomic +
-- create_order_with_items).
--
-- Adds `p_expected_version int` parameter (placed LAST to preserve positional
-- compatibility for existing named-arg callers) and a canonical FOR UPDATE
-- guard block that raises:
--   * 'STALE_VERSION'        with errcode = 'P0V01' on version mismatch
--   * 'NOT_FOUND_VERSIONED'  with errcode = 'P0V02' on missing tab row
-- and bumps `tabs.version = version + 1` on every successful UPDATE branch.
--
-- Group B (9 hook-side optimistic paths: close_tab, transfer_tab, void_order,
-- process_refund, add_combo_to_tab, assign_pool_session_to_tab, caja_open,
-- caja_close, register_caja_entry, start_pool_timer, stop_pool_timer) is NOT
-- modified here — it is migrated entirely in Plan 15-03 via hook-side
-- `.eq('version', expected)` filters. No SQL changes for Group B.
--
-- Existing record_audit() success-path calls (wired by Phase 14-03,
-- 20260511000002_rpc_audit_wiring.sql) are PRESERVED. The version guard sits
-- BEFORE the success-path audit — on P0V01/P0V02 the raise fires first and
-- nothing has been written, so audit is correctly skipped on conflict. Audit
-- on the conflict (error) branch is fired client-side from the hook's
-- onError handler (D-17 revised); a record_audit call inside the RPC body
-- after `raise exception` would be rolled back with the failed transaction.
--
-- 11 conflict-prone paths total: 2 RPC-guarded (this plan), 9 hook-optimistic
-- (Plan 15-03).
--
-- Depends on:
--   - 20260512000001_versioned_rows.sql (version columns + bump trigger)
--   - 20260511000002_rpc_audit_wiring.sql (record_audit wiring of process_payment_atomic)
--   - 20260428000003_create_order_with_items_v2.sql (current shape of create_order_with_items)
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. process_payment_atomic — add p_expected_version + FOR UPDATE guard
--    Source body: 20260511000002_rpc_audit_wiring.sql (+ p_expected_version
--    appended as the LAST positional parameter to preserve compatibility
--    with existing named-arg callers).
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

  SELECT COALESCE(ROUND(SUM(p.amount), 2), 0) INTO v_paid_line
  FROM payments p
  WHERE p.tab_id = p_tab_id
    AND p.is_refund = false;

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
-- 2. create_order_with_items — add p_expected_version + FOR UPDATE guard
--    Source body: 20260428000003_create_order_with_items_v2.sql (+
--    p_expected_version appended as the LAST positional parameter).
--    The original function only INSERTs into orders/order_items and does NOT
--    UPDATE tabs. Phase 15: append an explicit `update tabs set version =
--    version + 1` after the inserts so the bump trigger advances version
--    consistently with the optimistic-concurrency contract.
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_order_with_items(
  p_tab_id uuid,
  p_staff_id uuid,
  p_status order_status,
  p_notes text,
  p_items jsonb,
  p_skip_depletion boolean DEFAULT false,
  p_expected_version int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_items jsonb;
  v_inserted_item record;
  v_current int;
BEGIN
  -- Phase 15: lock tab row + assert expected_version (canonical guard).
  SELECT version INTO v_current FROM tabs WHERE id = p_tab_id FOR UPDATE;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;
  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  INSERT INTO orders (tab_id, staff_id, status, notes)
  VALUES (p_tab_id, p_staff_id, p_status, p_notes)
  RETURNING * INTO v_order;

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
    v_order.id,
    (elem->>'product_id')::uuid,
    COALESCE((elem->>'quantity')::int, 1),
    (elem->>'unit_price')::numeric,
    COALESCE(
      (
        SELECT array_agg(value::uuid)
        FROM jsonb_array_elements_text(COALESCE(elem->'modifier_ids', '[]'::jsonb)) AS t(value)
      ),
      ARRAY[]::uuid[]
    ),
    COALESCE((elem->>'modifier_price_delta')::numeric, 0),
    NULLIF(elem->>'notes', '')
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS elem;

  -- Phase 4: Deplete ingredients for each order item (same transaction).
  -- Skip when p_skip_depletion=true (manager override path — depletion called separately).
  IF NOT p_skip_depletion THEN
    FOR v_inserted_item IN
      SELECT id FROM order_items WHERE order_id = v_order.id
    LOOP
      PERFORM deplete_for_order_item(v_inserted_item.id, 1::smallint);
    END LOOP;
  END IF;

  -- Phase 15: bump tabs.version after successful insert. The
  -- bump_version_on_update trigger enforces exact +1 advancement.
  UPDATE tabs SET version = version + 1, updated_at = NOW() WHERE id = p_tab_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
  INTO v_items
  FROM order_items oi
  WHERE oi.order_id = v_order.id;

  RETURN jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_order_with_items(uuid, uuid, order_status, text, jsonb, boolean, int) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- Restoring the prior signatures requires re-applying:
--   - 20260511000002_rpc_audit_wiring.sql
--       process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT,
--                              NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC)
--   - 20260428000003_create_order_with_items_v2.sql
--       create_order_with_items(uuid, uuid, order_status, text, jsonb, boolean)
-- which will overwrite the version-guarded versions and remove the
-- p_expected_version parameter, the FOR UPDATE assertion block (P0V01/P0V02),
-- and the `version = version + 1` on the tabs UPDATE branches. There is no
-- destructive change to roll back beyond replaying those two migration files.
--
-- DROP FUNCTION IF EXISTS public.process_payment_atomic(UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT);
-- DROP FUNCTION IF EXISTS public.create_order_with_items(uuid, uuid, order_status, text, jsonb, boolean, int);
-- COMMIT;
-- =============================================================================
