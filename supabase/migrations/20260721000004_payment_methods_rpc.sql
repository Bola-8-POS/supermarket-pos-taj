-- =============================================================================
-- Phase 24 Plan 03 Task 3: payment-methods bounded report RPC (D-08)
--
-- Groups payments by method at TWO grains in one result set (D-08):
--   1. per-caja-session rows (cajaSessionId set, isRollup = false) — leg
--      count, gross amount, tip amount, grouped like CajaReportPanel.
--   2. one day-level rollup row per method (cajaSessionId = NULL,
--      isRollup = true) — client pins these to the table bottom.
--
-- MANDATORY (Phase 23 canonical exclusion, RESEARCH.md Assumption A3):
-- `is_deleted = FALSE AND status IS DISTINCT FROM 'reopened_void'` on every
-- payment-summing query, exactly as
-- 20260720000005_fix_payment_sums_exclude_reopened_void.sql patched into
-- get_caja_report/process_payment_atomic/etc. Omitting this re-inflates
-- revenue by counting a reopen-voided original payment. Also excludes
-- is_refund = TRUE rows, matching get_caja_report's existing posture.
--
-- Bounded on payments.processed_at (indexed via idx_payments_processed_at),
-- the payment's own timestamp column.
--
-- NOT pushed here — the single BLOCKING `npx supabase db push` is Plan 05.
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION get_payment_methods_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    -- Grain 1: per-caja-session + method
    SELECT
      tb.caja_session_id AS "cajaSessionId",
      p.method AS method,
      COUNT(*) AS "legCount",
      COALESCE(SUM(p.amount), 0) AS "grossAmount",
      COALESCE(SUM(p.tip_amount), 0) AS "tipAmount",
      FALSE AS "isRollup"
    FROM payments p
    JOIN tabs tb ON tb.id = p.tab_id
    WHERE p.is_deleted = FALSE
      AND p.status IS DISTINCT FROM 'reopened_void'
      AND p.is_refund = FALSE
      AND p.processed_at BETWEEN p_from AND p_to
    GROUP BY tb.caja_session_id, p.method

    UNION ALL

    -- Grain 2: day-level rollup per method (cajaSessionId = NULL, pinned to
    -- the table bottom by the client via isRollup)
    SELECT
      NULL::uuid AS "cajaSessionId",
      p.method AS method,
      COUNT(*) AS "legCount",
      COALESCE(SUM(p.amount), 0) AS "grossAmount",
      COALESCE(SUM(p.tip_amount), 0) AS "tipAmount",
      TRUE AS "isRollup"
    FROM payments p
    WHERE p.is_deleted = FALSE
      AND p.status IS DISTINCT FROM 'reopened_void'
      AND p.is_refund = FALSE
      AND p.processed_at BETWEEN p_from AND p_to
    GROUP BY p.method
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_payment_methods_report(timestamptz, timestamptz) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- Function is new. Rollback = drop it:
--   DROP FUNCTION IF EXISTS get_payment_methods_report(timestamptz, timestamptz);
-- =============================================================================
