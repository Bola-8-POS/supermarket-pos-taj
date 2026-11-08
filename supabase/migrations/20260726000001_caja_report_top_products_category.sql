-- =============================================================================
-- Phase 25 Plan 04 Task 1: category dimension on Caja Report top products +
-- camelCase JSON keys (D-03)
--
-- Source body: 20260720000005_fix_payment_sums_exclude_reopened_void.sql's
-- get_caja_report definition (the CURRENT one — get_caja_report has been
-- redefined three times since the original 20260420000004_caja_report_rpc.sql;
-- copying that stale original would silently revert the reopened_void
-- payment-sum exclusions, the notes field, and the totalExpenses/totalIncome/
-- netBalance/cajaEntries additions). This migration copies that body verbatim
-- and changes exactly two subqueries:
--
--   1. Top-products subquery — adds a LEFT JOIN to categories and two new
--      output columns (categoryId, categoryName) so the client can group the
--      existing top-10 rows by category. LIMIT 10 is unchanged — this is a
--      category-aware presentation of the same ten rows, not a per-category
--      rollup (RESEARCH.md Pitfall 3).
--
--   2. Both the top-products and staff-summary subqueries — pre-existing
--      defect fix: they emitted snake_case JSON keys (product_name, staff_id,
--      staff_name, order_count, sales_total) while
--      CajaReportTopProductSchema/CajaReportStaffSchema in domain.ts declare
--      camelCase field names, so CajaReportSchema.parse(data) in
--      useCajaReport failed for any caja session with a sale or staff row.
--      Not scope creep: a new camelCase field (categoryName) added next to a
--      snake_case sibling would fail the same parse, so this plan must fix
--      both to make SC-4 verifiable at all.
--
-- No other function in this file is touched. No supabase.types.ts
-- regeneration needed — category_id/categories.name/modifier_ids are
-- pre-existing generated columns and get_caja_report's return type is Json.
--
-- BLOCKING — Plan 04 Task 2 is the `supabase db push` that applies this.
-- =============================================================================

-- UP:
BEGIN;

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
  v_entries         JSON;
  v_total_expenses  NUMERIC(12,2) := 0;
  v_total_income    NUMERIC(12,2) := 0;
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
  SELECT
    COALESCE(SUM(amount + tip_amount), 0),
    COALESCE(SUM(CASE WHEN method = 'cash'  THEN amount + tip_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'card'  THEN amount + tip_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN method = 'rappi' THEN amount + tip_amount ELSE 0 END), 0)
  INTO v_total_revenue, v_cash_sales, v_card_sales, v_rappi_sales
  FROM payments
  WHERE tab_id = ANY(v_tab_ids)
    AND is_deleted = FALSE
    AND status IS DISTINCT FROM 'reopened_void';

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
  SELECT json_agg(row_to_json(s)) INTO v_staff_summary
  FROM (
    SELECT
      pr.id             AS "staffId",
      pr.name           AS "staffName",
      COUNT(DISTINCT o.id) AS "orderCount",
      COALESCE(SUM(pay.amount + pay.tip_amount), 0) AS "salesTotal"
    FROM profiles pr
    LEFT JOIN orders o  ON o.staff_id = pr.id
                        AND o.tab_id = ANY(v_tab_ids)
                        AND o.status <> 'voided'
                        AND o.is_deleted = FALSE
    LEFT JOIN payments pay ON pay.tab_id = ANY(v_tab_ids)
                           AND pay.processed_by = pr.id
                           AND pay.is_deleted = FALSE
                           AND pay.status IS DISTINCT FROM 'reopened_void'
    WHERE o.id IS NOT NULL OR pay.id IS NOT NULL
    GROUP BY pr.id, pr.name
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
      'totalRevenue',   v_total_revenue,
      'cashSales',      v_cash_sales,
      'cardSales',      v_card_sales,
      'rappiSales',     v_rappi_sales,
      'orderCount',     v_order_count,
      'tabCount',       v_tab_count,
      'totalExpenses',  v_total_expenses,
      'totalIncome',    v_total_income,
      'netBalance',     v_cash_sales + v_card_sales + v_rappi_sales + v_total_income - v_total_expenses
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
$$;

COMMIT;

-- =============================================================================
-- DOWN:
-- This migration replaces an existing function rather than creating a new
-- one. Rollback = re-apply the get_caja_report body from
-- 20260720000005_fix_payment_sums_exclude_reopened_void.sql verbatim, which
-- restores the non-category-aware, snake_case-keyed subqueries (and, with
-- them, the topProducts/staffSummary parse failure this migration fixes).
-- Supabase Cloud has no automated rollback mechanism.
-- =============================================================================
