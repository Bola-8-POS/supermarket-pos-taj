-- Line removal, refund and report bounds: caller gate on line removal,
-- per-line refund limits, weighed restock in the stock unit, per-staff caja
-- totals.

DROP POLICY IF EXISTS "order_items_delete_bartender" ON public.order_items;
DROP POLICY IF EXISTS "order_items_delete_manager_admin" ON public.order_items;

CREATE OR REPLACE FUNCTION public.remove_tab_item(p_item_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id uuid;
  v_before jsonb;
  v_remaining int;
  v_tab_status tab_status;
BEGIN
  -- Only an active, non-kitchen staff member may remove a line.
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('cashier', 'manager', 'admin')
  ) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: not allowed to remove lines';
  END IF;

  -- 1. Capture before-state (id/product_id/quantity/modifier_ids/etc.) +
  -- the owning order_id, in one shot -- avoids a second lookup after the
  -- row is gone.
  SELECT to_jsonb(oi.*), oi.order_id INTO v_before, v_order_id
  FROM order_items oi WHERE oi.id = p_item_id;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Defense-in-depth: only open tabs are eligible for item removal.
  SELECT t.status INTO v_tab_status
  FROM tabs t JOIN orders o ON o.id = v_order_id WHERE t.id = o.tab_id;

  IF v_tab_status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN');
  END IF;

  -- 2. Restore inventory BEFORE deleting -- deplete_for_order_item reads
  -- product_id/quantity/modifier_ids from the still-present row.
  -- Cast to smallint: deplete_for_order_item's p_direction is smallint, and
  -- int4->int2 is only an assignment cast (not implicit) in Postgres, so an
  -- unqualified `-1` integer literal fails overload resolution (42883).
  PERFORM deplete_for_order_item(p_item_id, (-1)::smallint, true);

  -- 3. Hard-delete the order_item.
  DELETE FROM order_items WHERE id = p_item_id;

  -- 4. Void the parent order if no items remain.
  SELECT COUNT(*) INTO v_remaining FROM order_items WHERE order_id = v_order_id;
  IF v_remaining = 0 THEN
    UPDATE orders SET status = 'voided' WHERE id = v_order_id;
  END IF;

  -- 5. Audit -- success path ONLY (mirrors edit_paid_tab: a raised exception
  -- rolls back the whole transaction including any audit insert attempted
  -- after it, so this must never sit inside an EXCEPTION block).
  PERFORM record_audit('order_item.remove', 'order_item', p_item_id, v_before,
    jsonb_build_object('reason', p_reason), 'rpc');

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.restore_inventory_on_order_item_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_sold_by_weight boolean;
  v_restore int;
BEGIN
  SELECT sold_by_weight INTO v_sold_by_weight FROM products WHERE id = OLD.product_id;
  v_restore := CASE WHEN COALESCE(v_sold_by_weight, false) THEN COALESCE(OLD.weight_grams, 0) ELSE OLD.quantity END;

  UPDATE inventory
  SET quantity_on_hand = quantity_on_hand + v_restore
  WHERE product_id = OLD.product_id;

  INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id)
  SELECT OLD.product_id, v_restore, 'correction', COALESCE(auth.uid(), o.staff_id)
  FROM orders o
  WHERE o.id = OLD.order_id;

  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_refund(p_original_payment_id uuid, p_items jsonb, p_reason text, p_approval_id uuid DEFAULT NULL::uuid, p_approver_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
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

  -- 2. Get original payment (must not itself be a refund, and must not
  --    already be voided by a reopen — Phase 23 Pitfall 6)
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
      -- consume_open_unit, not deplete_for_order_item: the latter reads
      -- order_items.quantity (the whole line) and would credit an
      -- open-unit product by the full line quantity on every partial
      -- refund; the refunded quantity is what must go back.
      PERFORM consume_open_unit(v_line.product_id, (v_item->>'qty')::integer, v_line.id, (-1)::smallint, true);
    END IF;
  END LOOP;

  -- 8. Insert negative payment row
  INSERT INTO payments (tab_id, amount, method, processed_at, processed_by, approved_by, is_refund, refund_id, idempotency_key)
  VALUES (
    v_payment.tab_id,
    -v_refund_total,
    v_payment.method,
    now(),
    v_caller,
    v_staff_id,
    true,
    v_refund_id,
    'refund-' || v_refund_id::text
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

  -- AUDIT: record refund (Phase 14-03)
  SELECT to_jsonb(r) || jsonb_build_object('approved_by', v_staff_id) INTO v_refund_row FROM refunds r WHERE r.id = v_refund_id;
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

CREATE OR REPLACE FUNCTION public.restore_inventory_on_refund_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_product_id uuid;
  v_staff_id uuid;
  v_restore integer;
BEGIN
  IF NOT NEW.restock THEN
    RETURN NEW;
  END IF;

  SELECT oi.product_id, r.created_by,
         CASE WHEN COALESCE(p.sold_by_weight, false)
              THEN ROUND(COALESCE(oi.weight_grams, 0) * NEW.qty::numeric / NULLIF(oi.quantity, 0))::integer
              ELSE NEW.qty END
    INTO v_product_id, v_staff_id, v_restore
    FROM order_items oi
    JOIN refunds r ON r.id = NEW.refund_id
    JOIN products p ON p.id = oi.product_id
   WHERE oi.id = NEW.order_item_id;

  IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id AND parent_product_id IS NULL) THEN
    UPDATE inventory
       SET quantity_on_hand = quantity_on_hand + COALESCE(v_restore, 0),
           updated_at = now()
     WHERE product_id = v_product_id;
    INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
    VALUES (v_product_id, COALESCE(v_restore, 0), 'refund', v_staff_id, 'refund', NEW.refund_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_caja_report(p_caja_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
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

  -- Collect tab ids for this caja
  SELECT array_agg(id) INTO v_tab_ids
  FROM tabs
  WHERE caja_session_id = p_caja_id AND is_deleted = FALSE;

  IF v_tab_ids IS NULL THEN
    v_tab_ids := '{}';
  END IF;

  v_tab_count := coalesce(array_length(v_tab_ids, 1), 0);

  -- Payment aggregates. Phase 23: exclude reopened_void rows so a voided
  -- original payment (un-done by reopen_tab) does not inflate revenue.
  -- Phase 23-05: v_bank_transfer_sales added alongside the existing three
  -- method sums — v_total_revenue's unconditional SUM(amount) is unchanged,
  -- so a bank-transfer sale already counts toward total revenue, unchanged.
  -- Configurable payment methods: v_uber_eats_sales added alongside
  -- v_rappi_sales, same shape, same "already in total revenue" reasoning.
  SELECT
    COALESCE(SUM(amount), 0),
    COALESCE(SUM(CASE WHEN method = 'cash'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'card'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'rappi' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'uber_eats' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'bank_transfer' THEN amount ELSE 0 END), 0)
  INTO v_total_revenue, v_cash_sales, v_card_sales, v_rappi_sales, v_uber_eats_sales, v_bank_transfer_sales
  FROM payments
  WHERE tab_id = ANY(v_tab_ids)
    AND is_deleted = FALSE
    AND status IS DISTINCT FROM 'reopened_void';

  -- Phase 23-05: still-unconfirmed portion of bank-transfer revenue (D-15) —
  -- same is_deleted/reopened_void guards as the aggregate above, for a
  -- comparable basis with v_bank_transfer_sales.
  SELECT COALESCE(SUM(p.amount), 0)
  INTO v_bank_transfer_pending
  FROM payments p
  JOIN bank_transfers bt ON bt.payment_id = p.id
  WHERE p.tab_id = ANY(v_tab_ids)
    AND p.is_deleted = FALSE
    AND p.status IS DISTINCT FROM 'reopened_void'
    AND bt.status = 'pending';

  -- Order count
  SELECT COUNT(*) INTO v_order_count
  FROM orders
  WHERE tab_id = ANY(v_tab_ids)
    AND status <> 'voided'
    AND is_deleted = FALSE;

  -- Caja entry totals
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)
  INTO v_total_expenses, v_total_income
  FROM caja_entries
  WHERE caja_session_id = p_caja_id;

  -- Caja entries list
  SELECT COALESCE(json_agg(
    json_build_object(
      'id',             e.id,
      'cajaSessionId',  e.caja_session_id,
      'type',           e.type,
      'amount',         e.amount,
      'concept',        e.concept,
      'createdAt',      e.created_at,
      'staffId',        e.staff_id,
      'staffName',      p.name
    ) ORDER BY e.created_at ASC
  ), '[]'::JSON)
  INTO v_entries
  FROM caja_entries e
  JOIN profiles p ON p.id = e.staff_id
  WHERE e.caja_session_id = p_caja_id;

  -- Top 10 products by quantity sold. Phase 25 Plan 04: LEFT JOIN categories
  -- adds the category dimension (a product with a null category_id still
  -- appears, with a null categoryName) and every alias is camelCased to
  -- match CajaReportTopProductSchema. LIMIT 10 unchanged (Pitfall 3).
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

  -- Staff performance summary. Phase 23: exclude reopened_void rows from
  -- the per-staff sales total, same reasoning as the top-level aggregate.
  -- Phase 25 Plan 04: every alias camelCased to match CajaReportStaffSchema.
  -- Wave 3a: two independently-aggregated subqueries, one per orders/payments,
  -- joined to profiles by staff id — the prior single LEFT JOIN of both
  -- orders and payments to profiles produced a cross-product per staff
  -- member, multiplying salesTotal by the staff member's order count.
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
      SELECT processed_by, SUM(amount) AS total FROM payments
      WHERE tab_id = ANY(v_tab_ids) AND is_deleted = FALSE AND status IS DISTINCT FROM 'reopened_void'
      GROUP BY processed_by
    ) pay ON pay.processed_by = pr.id
    WHERE o.staff_id IS NOT NULL OR pay.processed_by IS NOT NULL
    ORDER BY "salesTotal" DESC
  ) s;

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
    'cashReconciliation', json_build_object(
      'openingCash',  v_caja.opening_cash,
      'cashSales',    v_cash_sales,
      'expectedCash', v_caja.opening_cash + v_cash_sales,
      'closingCash',  v_caja.closing_cash,
      'variance',     CASE
        WHEN v_caja.closing_cash IS NOT NULL
        THEN v_caja.closing_cash - (v_caja.opening_cash + v_cash_sales)
        ELSE NULL
      END
    ),
    'topProducts',    COALESCE(v_top_products, '[]'::json),
    'staffSummary',   COALESCE(v_staff_summary, '[]'::json),
    'cajaEntries',    COALESCE(v_entries, '[]'::json)
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
