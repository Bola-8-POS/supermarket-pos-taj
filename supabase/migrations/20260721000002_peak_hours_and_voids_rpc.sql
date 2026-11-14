-- =============================================================================
-- Phase 24 Plan 03 Task 1: peak-hours + voids bounded report RPCs
--
-- Migrates the last two client-side unbounded report queries
-- (useHourlyBreakdown, useVoidRefundReport in
-- src/entities/tab/model/queries-reports.ts) to server-side SECURITY DEFINER
-- RPCs bounded by created_at/updated_at BETWEEN p_from AND p_to (SC-4).
-- Copied verbatim from the get_caja_report skeleton
-- (supabase/migrations/20260420000004_caja_report_rpc.sql): LANGUAGE plpgsql,
-- SECURITY DEFINER, json_build_object('ok', true, 'rows', ...) return shape.
--
-- get_peak_hours_report: verbatim template from 24-PATTERNS.md/RESEARCH.md
-- Pattern 1 — groups by hour AND day-of-week (D-03/D-04), bounded on
-- orders.created_at, excludes voided/soft-deleted orders.
--
-- get_voids_report: server-side equivalent of useVoidRefundReport's query
-- body — same VoidRefundRow shape (orderId, voidedAt, staffName, amount,
-- reason) unchanged so voids-excel/voids-pdf exporters need zero changes
-- (D-01/D-02). Preserves the existing client filter semantics (status =
-- 'voided', bounded on updated_at — the same column the client query used).
--
-- NOT pushed here — the single BLOCKING `npx supabase db push` is Plan 05.
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION get_peak_hours_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT EXTRACT(HOUR FROM o.created_at)::int AS hour,
           EXTRACT(DOW FROM o.created_at)::int AS "dayOfWeek",
           COUNT(DISTINCT o.id) AS "orderCount",
           COALESCE(SUM(oi.quantity * (oi.unit_price + oi.modifier_price_delta)), 0) AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status <> 'voided' AND o.is_deleted = FALSE
      AND o.created_at BETWEEN p_from AND p_to
    GROUP BY 1, 2
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_peak_hours_report(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION get_voids_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT
      o.id AS "orderId",
      COALESCE(o.voided_at, o.updated_at) AS "voidedAt",
      COALESCE(pr.name, '') AS "staffName",
      COALESCE(oi_sum.amount, 0) AS amount,
      COALESCE(o.void_reason, o.notes, '') AS reason
    FROM orders o
    LEFT JOIN profiles pr ON pr.id = o.staff_id
    LEFT JOIN LATERAL (
      SELECT SUM(oi.quantity * (oi.unit_price + oi.modifier_price_delta)) AS amount
      FROM order_items oi
      WHERE oi.order_id = o.id AND oi.is_deleted = FALSE
    ) oi_sum ON TRUE
    WHERE o.status = 'voided'
      AND o.updated_at BETWEEN p_from AND p_to
    ORDER BY o.updated_at DESC
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_voids_report(timestamptz, timestamptz) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- Both functions are new (no prior CREATE OR REPLACE generation exists).
-- Rollback = drop the functions:
--   DROP FUNCTION IF EXISTS get_peak_hours_report(timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS get_voids_report(timestamptz, timestamptz);
-- =============================================================================
