-- ============================================================================
-- FIX: Add missing `notes` field to get_caja_report RPC cajaSession object.
-- CajaSessionSchema requires notes (nullable). The original RPC omitted it,
-- causing Zod parse failures on the Reports page.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_caja_report(p_caja_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caja            RECORD;
  v_tab_ids         UUID[];
  v_total_revenue   NUMERIC(12,2);
  v_cash_sales      NUMERIC(12,2);
  v_card_sales      NUMERIC(12,2);
  v_rappi_sales     NUMERIC(12,2);
  v_order_count     INT;
  v_tab_count       INT;
  v_top_products    JSON;
  v_staff_summary   JSON;
  v_opened_by_name  TEXT;
  v_closed_by_name  TEXT;
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

  -- Payment aggregates
  SELECT
    COALESCE(SUM(amount + tip_amount), 0),
    COALESCE(SUM(CASE WHEN method = 'cash'  THEN amount + tip_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'card'  THEN amount + tip_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'rappi' THEN amount + tip_amount ELSE 0 END), 0)
  INTO v_total_revenue, v_cash_sales, v_card_sales, v_rappi_sales
  FROM payments
  WHERE tab_id = ANY(v_tab_ids) AND is_deleted = FALSE;

  -- Order count
  SELECT COUNT(*) INTO v_order_count
  FROM orders
  WHERE tab_id = ANY(v_tab_ids)
    AND status <> 'voided'
    AND is_deleted = FALSE;

  -- Top 10 products by quantity sold
  SELECT json_agg(row_to_json(t)) INTO v_top_products
  FROM (
    SELECT
      p.name            AS product_name,
      SUM(oi.quantity)  AS quantity,
      SUM(oi.quantity * oi.unit_price) AS revenue
    FROM order_items oi
    JOIN orders o    ON o.id = oi.order_id
    JOIN products p  ON p.id = oi.product_id
    WHERE o.tab_id = ANY(v_tab_ids)
      AND o.status <> 'voided'
      AND o.is_deleted = FALSE
      AND oi.is_deleted = FALSE
    GROUP BY p.id, p.name
    ORDER BY quantity DESC
    LIMIT 10
  ) t;

  -- Staff performance summary
  SELECT json_agg(row_to_json(s)) INTO v_staff_summary
  FROM (
    SELECT
      pr.id             AS staff_id,
      pr.name           AS staff_name,
      COUNT(DISTINCT o.id) AS order_count,
      COALESCE(SUM(pay.amount + pay.tip_amount), 0) AS sales_total
    FROM profiles pr
    LEFT JOIN orders o  ON o.staff_id = pr.id
                        AND o.tab_id = ANY(v_tab_ids)
                        AND o.status <> 'voided'
                        AND o.is_deleted = FALSE
    LEFT JOIN payments pay ON pay.tab_id = ANY(v_tab_ids)
                           AND pay.processed_by = pr.id
                           AND pay.is_deleted = FALSE
    WHERE o.id IS NOT NULL OR pay.id IS NOT NULL
    GROUP BY pr.id, pr.name
    ORDER BY sales_total DESC
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
      'totalRevenue',   v_total_revenue,
      'cashSales',      v_cash_sales,
      'cardSales',      v_card_sales,
      'rappiSales',     v_rappi_sales,
      'orderCount',     v_order_count,
      'tabCount',       v_tab_count
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
    'staffSummary',   COALESCE(v_staff_summary, '[]'::json)
  );
END;
$$;
