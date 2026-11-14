-- =============================================================================
-- Follow-up to 20260825000002 (get_product_sales_report): the same
-- PostgREST PGRST_DB_MAX_ROWS truncation bug exists in two more unbounded
-- client-side queries in the Inventory Analytics / Reports pages:
--
-- 1. useCategoryRevenueReport (src/entities/tab/model/queries-reports.ts)
--    fetched every order_item across ALL products for the date range,
--    identical failure mode to the already-fixed useProductSalesReport.
--    Fixed the same way: server-side bounded aggregation.
--
-- 2. useInventoryValuationReport / useTurnoverReport
--    (src/entities/inventory/model/queries-analytics.ts) both fetched every
--    stock_movements row after a cutoff date with no bound — this is
--    unbounded on BOTH ends (grows forever, no upper date limit) and is the
--    empirically-reproduced instance from the prior fix's final review (the
--    shrinkage/waste report undercounted once filler stock_movements rows
--    pushed the day's total past 1000). Rather than duplicate the
--    quantity-reconstruction arithmetic in SQL, get_stock_movement_deltas_after
--    pre-aggregates SUM(quantity_delta) per product server-side (bounded by
--    product count, not movement count) and the client feeds that single
--    synthetic delta per product into the EXISTING, already-unit-tested
--    computeInventoryValueAsOf pure function — zero duplicated business logic,
--    same tested arithmetic, just a bounded data source.
--
-- fetchShrinkageMovements (used by useShrinkageWasteReport/useExpiryLossReport)
-- is fixed separately, client-side only (no new RPC needed) — it was fetching
-- ALL stock_movements rows including irrelevant 'sale'-reason ones just to
-- discard them client-side; adding a WHERE filter for loss-only rows
-- (quantity_delta < 0, reason IN loss-reasons) at the query level removes the
-- waste and dramatically shrinks realistic row counts, since loss events are
-- inherently far rarer than sales. See the corresponding TS change.
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION get_category_revenue_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT
      cat.id AS "categoryId",
      cat.name AS "categoryName",
      SUM(oi.quantity) AS "unitsSold",
      COUNT(*) AS "orderCount",
      ROUND(SUM(oi.quantity * (oi.unit_price + oi.modifier_price_delta))::numeric, 2) AS revenue
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
    GROUP BY cat.id, cat.name
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_category_revenue_report(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION get_stock_movement_deltas_after(p_after timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT
      product_id AS "productId",
      SUM(quantity_delta) AS "deltaSum"
    FROM stock_movements
    WHERE created_at > p_after
    GROUP BY product_id
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_stock_movement_deltas_after(timestamptz) TO authenticated;

-- useTurnoverReport needs deltas after TWO cutoffs (from, to) to reconstruct
-- both valuation points. Two separate get_stock_movement_deltas_after calls
-- would work but doubles this page's round trips vs. the original
-- single-fetch design (movements after `from` is a superset of movements
-- after `to`, so the old code fetched once and reused the raw rows for both
-- reconstructions) — on this project's shared local dev DB, extra round
-- trips widen the window for a concurrent writer's changes to land between
-- fetch and render. One two-cutoff RPC restores the single-round-trip shape
-- while staying fully bounded (server-side SUM, not raw rows).
CREATE OR REPLACE FUNCTION get_stock_movement_deltas_two_cutoffs(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT
      product_id AS "productId",
      COALESCE(SUM(quantity_delta) FILTER (WHERE created_at > p_from), 0) AS "deltaSumFrom",
      COALESCE(SUM(quantity_delta) FILTER (WHERE created_at > p_to), 0) AS "deltaSumTo"
    FROM stock_movements
    WHERE created_at > p_from
    GROUP BY product_id
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_stock_movement_deltas_two_cutoffs(timestamptz, timestamptz) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
--   DROP FUNCTION IF EXISTS get_category_revenue_report(timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS get_stock_movement_deltas_after(timestamptz);
--   DROP FUNCTION IF EXISTS get_stock_movement_deltas_two_cutoffs(timestamptz, timestamptz);
-- =============================================================================
