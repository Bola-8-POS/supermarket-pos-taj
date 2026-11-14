-- =============================================================================
-- Fix WINDOWS.md #27: useProductSalesReport fetched every product's
-- order_items for the date range with no pagination and no deterministic
-- ORDER BY, then aggregated client-side. Once a day's order_items exceed
-- PostgREST's PGRST_DB_MAX_ROWS (1000 locally), the response silently
-- truncates and any single product's units-sold can undercount.
--
-- Same fix this codebase already applied for Hourly Breakdown and
-- Void/Refund (supabase/migrations/20260721000002_peak_hours_and_voids_rpc.sql):
-- move the aggregation server-side into a bounded SECURITY DEFINER RPC that
-- returns one JSON row (not N table rows), so PostgREST's per-row cap never
-- applies. Formulas verified against
-- src/entities/tab/model/product-sales-report.integration.test.ts's exact
-- fixture numbers (beer: 5 units/$50 revenue/$8 cost/$12 margin; spirits:
-- 1 unit/$30 revenue/$20 cost/$10 margin; weighted-line cost uses
-- weight_grams/1000 factor, not just revenue).
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION get_product_sales_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    WITH agg AS (
      SELECT
        oi.product_id AS product_id,
        p.name AS product_name,
        cat.name AS category_name,
        SUM(oi.quantity) AS units,
        SUM(oi.quantity * (oi.unit_price + oi.modifier_price_delta)) AS revenue,
        SUM(oi.quantity * (oi.unit_price + oi.modifier_price_delta))
          FILTER (WHERE oi.cost_price_snapshot IS NOT NULL) AS margin_revenue,
        SUM(oi.quantity * oi.cost_price_snapshot * COALESCE(oi.weight_grams, 1000)::numeric / 1000)
          FILTER (WHERE oi.cost_price_snapshot IS NOT NULL) AS cost_total,
        bool_or(oi.cost_price_snapshot IS NOT NULL) AS has_cost
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN tabs tb ON tb.id = o.tab_id
      LEFT JOIN products p ON p.id = oi.product_id
      LEFT JOIN categories cat ON cat.id = p.category_id
      WHERE o.status <> 'voided'
        AND oi.is_deleted = FALSE
        AND o.is_deleted = FALSE
        AND tb.is_deleted = FALSE
        AND tb.created_at BETWEEN p_from AND p_to
      GROUP BY oi.product_id, p.name, cat.name
    )
    SELECT
      product_id AS "productId",
      product_name AS "productName",
      category_name AS "categoryName",
      units,
      ROUND(revenue::numeric, 2) AS revenue,
      CASE WHEN has_cost THEN ROUND(COALESCE(cost_total, 0)::numeric, 2) ELSE NULL END AS "costTotal",
      CASE WHEN has_cost THEN ROUND((COALESCE(margin_revenue, 0) - COALESCE(cost_total, 0))::numeric, 2) ELSE NULL END AS margin,
      CASE
        WHEN has_cost AND COALESCE(margin_revenue, 0) <> 0
          THEN ROUND(((margin_revenue - cost_total) / margin_revenue * 100)::numeric, 2)
        ELSE NULL
      END AS "marginPct"
    FROM agg
    ORDER BY revenue DESC
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_product_sales_report(timestamptz, timestamptz) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN: DROP FUNCTION IF EXISTS get_product_sales_report(timestamptz, timestamptz);
-- =============================================================================
