-- One drawer-cash definition for the close RPC and the report, plus refund
-- attribution to the caja session that pays it out.
--
-- 1. payments.caja_session_id: set only on a refund row, naming the session
--    whose drawer the cash leaves. A sale keeps it NULL; its session comes
--    from the tab, as before.
-- 1b. caja_entries.source distinguishes a manual entry from the offsetting
--    entry a tab reopen writes and the delta entry a paid-tab edit writes,
--    so a reopen offset (the voided payment is already excluded from every
--    sum) is not subtracted a second time as an entry.
-- 1c. caja_sessions.cash_reconciliation freezes the figures close_caja_session
--    showed the cashier, so a report never contradicts what was seen at close.
-- 2. caja_session_payments(uuid): the one attributed-payments query, shared by
--    the helper below and by get_caja_report.
--    caja_cash_reconciliation(uuid): the one cash-drawer figure, shared by
--    close_caja_session and get_caja_report.
-- 3. close_caja_session: computes its reconciliation from the helper (after
--    taking the row lock) and stores it.
-- 4. get_caja_report: every payment sum reads from caja_session_payments;
--    a closed session with a stored reconciliation returns it unchanged.
-- 5. process_refund: gains a sixth argument, p_caja_session_id, checked open
--    before any write, and attributes the refund payment row to it.
-- 6. The payment.refund audit row's after payload gains cajaSessionId.

-- ---------------------------------------------------------------------------
-- 1. payments.caja_session_id
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS caja_session_id uuid NULL REFERENCES caja_sessions(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS payments_caja_session_id_idx
  ON payments (caja_session_id)
  WHERE caja_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1b. caja_entries.source
-- ---------------------------------------------------------------------------
ALTER TABLE caja_entries
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'reopen', 'edit'));

UPDATE caja_entries SET source = 'reopen' WHERE concept LIKE 'Reopen tab %';

-- ---------------------------------------------------------------------------
-- 1c. caja_sessions.cash_reconciliation
-- ---------------------------------------------------------------------------
ALTER TABLE caja_sessions
  ADD COLUMN IF NOT EXISTS cash_reconciliation jsonb NULL;

-- ---------------------------------------------------------------------------
-- 2. caja_session_payments — the one attributed-payments query.
--
-- A string body (never BEGIN ATOMIC): the next migration widens `payments`,
-- and a string body is re-planned against the row type in effect at call
-- time instead of freezing the column list this migration sees.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_session_payments(p_caja_id uuid)
RETURNS SETOF payments
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT p.* FROM payments p WHERE p.caja_session_id = p_caja_id
    AND p.is_deleted = FALSE AND p.status IS DISTINCT FROM 'reopened_void'
  UNION ALL
  SELECT p.* FROM payments p JOIN tabs t ON t.id = p.tab_id
    WHERE t.caja_session_id = p_caja_id AND p.caja_session_id IS NULL
      AND t.is_deleted = FALSE AND p.is_deleted = FALSE AND p.status IS DISTINCT FROM 'reopened_void'
$$;

REVOKE EXECUTE ON FUNCTION public.caja_session_payments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caja_session_payments(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 (cont.). caja_cash_reconciliation — the one cash-drawer figure.
--
-- Missing session: the cross join with the zero-row `session` CTE returns no
-- rows, so the function's scalar result is NULL (callers already raise on an
-- unknown session).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_cash_reconciliation(p_caja_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH session AS (
    SELECT opening_cash FROM caja_sessions WHERE id = p_caja_id
  ), cash AS (
    SELECT COALESCE(SUM(amount), 0) AS cash_sales
    FROM caja_session_payments(p_caja_id)
    WHERE method = 'cash'
  ), entries AS (
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE type = 'income' AND source <> 'reopen'), 0) AS cash_in,
      COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND source <> 'reopen'), 0) AS cash_out
    FROM caja_entries
    WHERE caja_session_id = p_caja_id
  )
  SELECT jsonb_build_object(
    'openingCash', ROUND(session.opening_cash, 2),
    'cashSales', ROUND(cash.cash_sales, 2),
    'cashIn', ROUND(entries.cash_in, 2),
    'cashOut', ROUND(entries.cash_out, 2),
    'expectedCash', ROUND(session.opening_cash + cash.cash_sales + entries.cash_in - entries.cash_out, 2)
  )
  FROM session, cash, entries
$$;

REVOKE EXECUTE ON FUNCTION public.caja_cash_reconciliation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caja_cash_reconciliation(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. close_caja_session — same shape, cash figures from the shared helper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_caja_session(p_caja_id uuid, p_closed_by uuid, p_closing_cash numeric, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open_tab_count INT;
  v_caller_role TEXT;
  v_before_row jsonb;
  v_after_row jsonb;
  v_recon jsonb;
BEGIN
  SELECT role INTO v_caller_role FROM profiles WHERE id = auth.uid() AND is_active = true;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('manager', 'admin') THEN
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

  SELECT to_jsonb(c) INTO v_before_row FROM caja_sessions c WHERE c.id = p_caja_id;

  -- The row lock is taken first, so a concurrent process_refund waiting on
  -- this session's FOR SHARE lock sees the session already closed.
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

  v_recon := caja_cash_reconciliation(p_caja_id);
  v_recon := v_recon || jsonb_build_object(
    'closingCash', p_closing_cash,
    'variance', ROUND(p_closing_cash - (v_recon->>'expectedCash')::numeric, 2)
  );

  -- bump_version_on_update requires every UPDATE to advance version by
  -- exactly 1, so this second write bumps it again.
  UPDATE caja_sessions SET cash_reconciliation = v_recon, version = version + 1 WHERE id = p_caja_id;

  SELECT to_jsonb(c) INTO v_after_row FROM caja_sessions c WHERE c.id = p_caja_id;
  PERFORM record_audit('caja.close', 'caja_session', p_caja_id, v_before_row, v_after_row, 'rpc');

  RETURN json_build_object(
    'ok', true,
    'cashReconciliation', v_recon
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. get_caja_report — every payment sum reads from caja_session_payments;
--    a closed session's stored reconciliation is returned unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_caja_report(p_caja_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caja                   RECORD;
  v_tab_ids                UUID[];
  v_total_revenue          NUMERIC(12,2);
  v_cash_sales              NUMERIC(12,2);
  v_card_sales              NUMERIC(12,2);
  v_rappi_sales             NUMERIC(12,2);
  v_uber_eats_sales         NUMERIC(12,2);
  v_bank_transfer_sales     NUMERIC(12,2);
  v_bank_transfer_pending   NUMERIC(12,2);
  v_order_count             INT;
  v_tab_count               INT;
  v_top_products            JSON;
  v_staff_summary           JSON;
  v_opened_by_name          TEXT;
  v_closed_by_name          TEXT;
  v_entries                 JSON;
  v_total_expenses          NUMERIC(12,2) := 0;
  v_total_income            NUMERIC(12,2) := 0;
  v_recon_calc              jsonb;
  v_cash_recon              jsonb;
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

  -- Collect tab ids for this caja (unchanged: topProducts/orderCount/tabCount
  -- stay tab-based by definition).
  SELECT array_agg(id) INTO v_tab_ids
  FROM tabs
  WHERE caja_session_id = p_caja_id AND is_deleted = FALSE;

  IF v_tab_ids IS NULL THEN
    v_tab_ids := '{}';
  END IF;

  v_tab_count := coalesce(array_length(v_tab_ids, 1), 0);

  -- Payment aggregates now read from the shared attributed-payments query, so
  -- a refund attributed to this session (via payments.caja_session_id) is
  -- included even when its tab belongs to a different session, and a refund
  -- attributed elsewhere is excluded even when its tab belongs to this one.
  SELECT
    COALESCE(SUM(amount), 0),
    COALESCE(SUM(CASE WHEN method = 'cash'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'card'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'rappi' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'uber_eats' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'bank_transfer' THEN amount ELSE 0 END), 0)
  INTO v_total_revenue, v_cash_sales, v_card_sales, v_rappi_sales, v_uber_eats_sales, v_bank_transfer_sales
  FROM caja_session_payments(p_caja_id);

  SELECT COALESCE(SUM(p.amount), 0)
  INTO v_bank_transfer_pending
  FROM caja_session_payments(p_caja_id) p
  JOIN bank_transfers bt ON bt.payment_id = p.id
  WHERE bt.status = 'pending';

  -- Order count
  SELECT COUNT(*) INTO v_order_count
  FROM orders
  WHERE tab_id = ANY(v_tab_ids)
    AND status <> 'voided'
    AND is_deleted = FALSE;

  -- Caja entry totals — a reopen's offsetting entry is excluded: the payment
  -- it voided is already excluded from every payment sum above, so counting
  -- the offset entry too would subtract the same sale twice.
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND source <> 'reopen'), 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'income' AND source <> 'reopen'), 0)
  INTO v_total_expenses, v_total_income
  FROM caja_entries
  WHERE caja_session_id = p_caja_id;

  -- Caja entries list (gains `source`)
  SELECT COALESCE(json_agg(
    json_build_object(
      'id',             e.id,
      'cajaSessionId',  e.caja_session_id,
      'type',           e.type,
      'amount',         e.amount,
      'concept',        e.concept,
      'createdAt',      e.created_at,
      'staffId',        e.staff_id,
      'staffName',      p.name,
      'source',         e.source
    ) ORDER BY e.created_at ASC
  ), '[]'::JSON)
  INTO v_entries
  FROM caja_entries e
  JOIN profiles p ON p.id = e.staff_id
  WHERE e.caja_session_id = p_caja_id;

  -- Top 10 products by quantity sold (unchanged, tab-based).
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

  -- Staff performance summary: the payments side now reads from the shared
  -- attributed-payments query, so a refund shows against whoever processed
  -- it in the session that pays it, not the session of the original sale.
  SELECT json_agg(row_to_json(s)) INTO v_staff_summary FROM (
    SELECT
      pr.id AS "staffId", pr.name AS "staffName",
      COALESCE(o.cnt, 0) AS "orderCount",
      COALESCE(pay.total, 0) AS "salesTotal"
    FROM profiles pr
    LEFT JOIN (
      SELECT staff_id, COUNT(*) AS cnt FROM orders
      WHERE tab_id = ANY(v_tab_ids) AND status <> 'voided' AND is_deleted = FALSE
      GROUP BY staff_id
    ) o ON o.staff_id = pr.id
    LEFT JOIN (
      SELECT processed_by, SUM(amount) AS total FROM caja_session_payments(p_caja_id)
      GROUP BY processed_by
    ) pay ON pay.processed_by = pr.id
    WHERE o.staff_id IS NOT NULL OR pay.processed_by IS NOT NULL
    ORDER BY "salesTotal" DESC
  ) s;

  -- cashReconciliation: a closed session with a stored figure returns it
  -- unchanged (frozen at close); otherwise computed live, once, plus the
  -- current closingCash/variance.
  IF v_caja.status = 'closed' AND v_caja.cash_reconciliation IS NOT NULL THEN
    v_cash_recon := v_caja.cash_reconciliation;
  ELSE
    v_recon_calc := caja_cash_reconciliation(p_caja_id);
    v_cash_recon := v_recon_calc || jsonb_build_object(
      'closingCash', v_caja.closing_cash,
      'variance', CASE
        WHEN v_caja.closing_cash IS NOT NULL
        THEN ROUND(v_caja.closing_cash - (v_recon_calc->>'expectedCash')::numeric, 2)
        ELSE NULL
      END
    );
  END IF;

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
      'totalRevenue',        v_total_revenue,
      'cashSales',           v_cash_sales,
      'cardSales',           v_card_sales,
      'rappiSales',          v_rappi_sales,
      'uberEatsSales',       v_uber_eats_sales,
      'bankTransferSales',   v_bank_transfer_sales,
      'bankTransferPending', v_bank_transfer_pending,
      'orderCount',          v_order_count,
      'tabCount',            v_tab_count,
      'totalExpenses',       v_total_expenses,
      'totalIncome',         v_total_income,
      'netBalance',          v_cash_sales + v_card_sales + v_rappi_sales + v_uber_eats_sales + v_bank_transfer_sales + v_total_income - v_total_expenses
    ),
    'cashReconciliation', v_cash_recon,
    'topProducts',    COALESCE(v_top_products, '[]'::json),
    'staffSummary',   COALESCE(v_staff_summary, '[]'::json),
    'cajaEntries',    COALESCE(v_entries, '[]'::json)
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. process_refund — sixth argument p_caja_session_id, checked open before
--    any write, attributed on the refund payment row.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.process_refund(uuid, jsonb, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.process_refund(uuid, jsonb, text, uuid, uuid, uuid);

CREATE FUNCTION public.process_refund(
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

  -- 8. Insert negative payment row, attributed to the paying session when named.
  INSERT INTO payments (tab_id, amount, method, processed_at, processed_by, approved_by, is_refund, refund_id, idempotency_key, caja_session_id)
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
    p_caja_session_id
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

-- ---------------------------------------------------------------------------
-- 1b (cont.). reopen_tab / edit_paid_tab — same signatures, their caja_entries
-- INSERT now tags the row with `source`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reopen_tab(p_tab_id uuid, p_expected_version integer, p_reason text, p_approval_id uuid DEFAULT NULL::uuid, p_approver_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_staff_id uuid;
  v_current int;
  v_status tab_status;
  v_reopen_count int;
  v_last_reopened timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_voided_total numeric;
  v_caja uuid;
  v_terminal text;
  v_concept text;
  v_approval jsonb;
BEGIN
  v_approval := resolve_manager_approval(p_approval_id, p_approver_id, 'reopen_tab', auth.uid());
  IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
    IF v_approval->>'code' = 'LOCKED' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                'retryAfter', (v_approval->>'retry_after')::integer);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN', 'message', 'manager or admin role required');
  END IF;
  v_staff_id := (v_approval->>'approver_id')::uuid;

  SELECT version, status, reopen_count, last_reopened_at
  INTO v_current, v_status, v_reopen_count, v_last_reopened
  FROM tabs WHERE id = p_tab_id FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_status NOT IN ('closed', 'paid') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'TAB_NOT_REOPENABLE',
      'message', 'Only closed or paid tabs can be reopened'
    );
  END IF;

  IF v_reopen_count >= 2 THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'REOPEN_CAP_EXCEEDED',
      'message', 'This tab has already been reopened twice'
    );
  END IF;

  IF v_last_reopened IS NOT NULL AND NOW() - v_last_reopened > INTERVAL '24 hours' THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'REOPEN_WINDOW_EXPIRED',
      'message', 'Reopen window has expired'
    );
  END IF;

  SELECT to_jsonb(t.*) INTO v_before FROM tabs t WHERE t.id = p_tab_id;

  WITH newly_voided AS (
    UPDATE payments
    SET status = 'reopened_void', updated_at = NOW()
    WHERE tab_id = p_tab_id AND is_refund = false AND status = 'completed'
    RETURNING amount
  )
  SELECT COALESCE(SUM(amount), 0) INTO v_voided_total FROM newly_voided;

  IF v_voided_total <> 0 THEN
    SELECT cs.terminal_id INTO v_terminal
    FROM tabs t JOIN caja_sessions cs ON cs.id = t.caja_session_id
    WHERE t.id = p_tab_id;

    IF v_terminal IS NOT NULL THEN
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' AND terminal_id = v_terminal LIMIT 1;
    ELSE
      -- No resolvable original terminal (legacy tab with no caja_session_id)
      -- — fall back to the pre-per-terminal-caja behavior.
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' LIMIT 1;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPEN_CAJA: an open caja session is required to record a reopen adjustment'
        USING ERRCODE = 'P0A02';
    END IF;

    v_concept := left(
      format(
        'Reopen tab %s: %s',
        substr(p_tab_id::text, 1, 8),
        regexp_replace(COALESCE(NULLIF(TRIM(p_reason), ''), 'no reason given'), '[,.()]', '', 'g')
      ),
      200
    );

    INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id, source)
    VALUES (v_caja, 'expense', v_voided_total, v_concept, v_staff_id, 'reopen');
  END IF;

  UPDATE tabs
  SET status = 'open', closed_at = NULL, reopen_count = reopen_count + 1,
      last_reopened_at = NOW(), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  SELECT to_jsonb(t.*) || jsonb_build_object('reason', p_reason, 'approved_by', v_staff_id)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  PERFORM record_audit('tab.reopen', 'tab', p_tab_id, v_before, v_after, 'rpc');

  RETURN jsonb_build_object('ok', true, 'voidedPaymentTotal', v_voided_total);

EXCEPTION
  WHEN sqlstate 'P0V01' THEN
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    RAISE;
  WHEN sqlstate 'P0A01' THEN
    RAISE;
  WHEN sqlstate 'P0A02' THEN
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.edit_paid_tab(p_tab_id uuid, p_expected_version integer, p_order_item_patches jsonb, p_notes text, p_reason text, p_approval_id uuid DEFAULT NULL::uuid, p_approver_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_staff_id uuid;
  v_current int;
  v_status tab_status;
  v_before jsonb;
  v_after jsonb;
  v_old_total numeric;
  v_new_total numeric;
  v_delta numeric;
  v_caja uuid;
  v_terminal text;
  v_concept text;
  v_sanitized_reason text;
  v_short_id text;
  v_orig_date text;
  v_last_order_id uuid;
  v_patch jsonb;
  v_op text;
  v_item_product_id uuid;
  v_old_qty int;
  v_new_qty int;
  v_qty_delta int;
  v_approval jsonb;
BEGIN
  v_approval := resolve_manager_approval(p_approval_id, p_approver_id, 'edit_paid_tab', auth.uid());
  IF NOT COALESCE((v_approval->>'ok')::boolean, false) THEN
    IF v_approval->>'code' = 'LOCKED' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PIN_LOCKED', 'message', 'Too many attempts',
                                'retryAfter', (v_approval->>'retry_after')::integer);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN', 'message', 'manager or admin role required');
  END IF;
  v_staff_id := (v_approval->>'approver_id')::uuid;

  SELECT version, status INTO v_current, v_status
  FROM tabs WHERE id = p_tab_id FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;

  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

  IF v_status NOT IN ('paid', 'closed') THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'TAB_NOT_EDITABLE',
      'message', 'Only paid or closed tabs can be edited'
    );
  END IF;

  SELECT to_jsonb(t.*) || jsonb_build_object(
    'items', (
      SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tab_id = p_tab_id AND oi.is_deleted = false
    )
  )
  INTO v_before
  FROM tabs t WHERE t.id = p_tab_id;

  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_old_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false;

  SELECT o.id INTO v_last_order_id
  FROM orders o WHERE o.tab_id = p_tab_id
  ORDER BY o.created_at DESC LIMIT 1;

  FOR v_patch IN SELECT * FROM jsonb_array_elements(COALESCE(p_order_item_patches, '[]'::jsonb))
  LOOP
    v_op := v_patch->>'op';

    IF v_op = 'update' THEN
      SELECT product_id, quantity INTO v_item_product_id, v_old_qty
      FROM order_items
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id);

      UPDATE order_items
      SET
        quantity = COALESCE((v_patch->>'quantity')::int, quantity),
        unit_price = COALESCE((v_patch->>'unit_price')::numeric, unit_price),
        notes = COALESCE(v_patch->>'notes', notes),
        updated_at = NOW()
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id)
      RETURNING quantity INTO v_new_qty;

      IF v_item_product_id IS NOT NULL AND v_new_qty IS NOT NULL AND v_new_qty <> v_old_qty THEN
        v_qty_delta := v_new_qty - v_old_qty;

        UPDATE inventory
        SET quantity_on_hand = quantity_on_hand - v_qty_delta, updated_at = NOW()
        WHERE product_id = v_item_product_id;

        INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
        VALUES (v_item_product_id, -v_qty_delta, 'correction', v_staff_id, 'order_item', (v_patch->>'id')::uuid);
      END IF;

    ELSIF v_op = 'delete' THEN
      UPDATE order_items
      SET is_deleted = true, deleted_at = NOW()
      WHERE id = (v_patch->>'id')::uuid
        AND order_id IN (SELECT o.id FROM orders o WHERE o.tab_id = p_tab_id)
      RETURNING product_id, quantity INTO v_item_product_id, v_old_qty;

      IF v_item_product_id IS NOT NULL THEN
        UPDATE inventory
        SET quantity_on_hand = quantity_on_hand + v_old_qty, updated_at = NOW()
        WHERE product_id = v_item_product_id;

        INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
        VALUES (v_item_product_id, v_old_qty, 'correction', v_staff_id, 'order_item', (v_patch->>'id')::uuid);
      END IF;

    ELSIF v_op = 'add' THEN
      IF v_last_order_id IS NULL THEN
        RAISE EXCEPTION 'NO_ORDER_FOUND: tab % has no orders to attach a new item to', p_tab_id;
      END IF;
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, notes)
      VALUES (
        v_last_order_id,
        (v_patch->>'product_id')::uuid,
        COALESCE((v_patch->>'quantity')::int, 1),
        (v_patch->>'unit_price')::numeric,
        NULLIF(v_patch->>'notes', '')
      );
    END IF;
  END LOOP;

  SELECT COALESCE(ROUND(SUM(oi.unit_price * oi.quantity), 2), 0) INTO v_new_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_tab_id AND oi.parent_order_item_id IS NULL AND oi.is_deleted = false;

  v_delta := v_new_total - v_old_total;

  IF v_delta <> 0 THEN
    SELECT cs.terminal_id INTO v_terminal
    FROM tabs t JOIN caja_sessions cs ON cs.id = t.caja_session_id
    WHERE t.id = p_tab_id;

    IF v_terminal IS NOT NULL THEN
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' AND terminal_id = v_terminal LIMIT 1;
    ELSE
      SELECT id INTO v_caja FROM caja_sessions WHERE status = 'open' LIMIT 1;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'NO_OPEN_CAJA: an open caja session is required to record a total-changing edit'
        USING ERRCODE = 'P0A02';
    END IF;

    SELECT substr(t.id::text, 1, 8), to_char(t.opened_at, 'YYYY-MM-DD')
    INTO v_short_id, v_orig_date
    FROM tabs t WHERE t.id = p_tab_id;

    v_sanitized_reason := regexp_replace(COALESCE(NULLIF(TRIM(p_reason), ''), 'no reason given'), '[,.()]', '', 'g');

    v_concept := left(
      format('Edit paid tab %s (%s): %s', v_short_id, v_orig_date, v_sanitized_reason),
      200
    );

    INSERT INTO caja_entries (caja_session_id, type, amount, concept, staff_id, source)
    VALUES (
      v_caja,
      CASE WHEN v_delta > 0 THEN 'income' ELSE 'expense' END,
      abs(v_delta),
      v_concept,
      v_staff_id,
      'edit'
    );
  END IF;

  UPDATE tabs
  SET notes = COALESCE(p_notes, notes), version = version + 1, updated_at = NOW()
  WHERE id = p_tab_id;

  SELECT to_jsonb(t.*) || jsonb_build_object(
    'items', (
      SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tab_id = p_tab_id AND oi.is_deleted = false
    )
  ) || jsonb_build_object('reason', p_reason, 'approved_by', v_staff_id)
  INTO v_after
  FROM tabs t WHERE t.id = p_tab_id;

  PERFORM record_audit('tab.edit_paid', 'tab', p_tab_id, v_before, v_after, 'rpc');

  RETURN jsonb_build_object(
    'ok', true,
    'newTotal', v_new_total,
    'delta', v_delta,
    'cajaAdjustmentRecorded', v_delta <> 0
  );

EXCEPTION
  WHEN sqlstate 'P0V01' THEN
    RAISE;
  WHEN sqlstate 'P0V02' THEN
    RAISE;
  WHEN sqlstate 'P0A01' THEN
    RAISE;
  WHEN sqlstate 'P0A02' THEN
    RAISE;
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INTERNAL', 'message', SQLERRM);
END;
$function$;
