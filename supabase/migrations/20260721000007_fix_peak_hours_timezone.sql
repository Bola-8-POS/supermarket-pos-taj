-- =============================================================================
-- Phase 24 Plan 06 fix — get_peak_hours_report bucketed hour/day-of-week in
-- the Postgres session timezone (UTC on Supabase) instead of the bar's own
-- local timezone, silently shifting every order into the wrong hour bucket
-- whenever the caller's local timezone offset is non-zero (verified via
-- src/entities/tab/model/hourly-breakdown.integration.test.ts, which seeds
-- orders at explicit local hours and failed post-migration in
-- America/Mexico_City: hour 8 read back as hour 14/hour 20 read back as
-- hour 2 the next day).
--
-- Every other daily-rollup reporting view in this codebase already bucketing
-- by wall-clock day converts via `AT TIME ZONE 'America/Mexico_City'` first
-- (supabase/migrations/20260505000001_s6_reporting_views.sql — combo_mix_daily,
-- recipe_variance_daily, waitlist_metrics_daily). get_peak_hours_report
-- (20260721000002_peak_hours_and_voids_rpc.sql) is the only new/migrated RPC
-- in this phase that extracts HOUR/DOW and it was missing that same
-- conversion. get_voids_report/get_deletions_*_report/
-- get_modifier_popularity_report/get_payment_methods_report only bound a
-- date RANGE (no HOUR/DOW extraction) so they are unaffected.
--
-- Fix: extract HOUR/DOW from `o.created_at AT TIME ZONE 'America/Mexico_City'`
-- instead of the raw timestamptz. Rest of the function body is unchanged
-- from 20260721000002 (CREATE OR REPLACE FUNCTION replaces the whole body).
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION get_peak_hours_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'America/Mexico_City')::int AS hour,
           EXTRACT(DOW FROM o.created_at AT TIME ZONE 'America/Mexico_City')::int AS "dayOfWeek",
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

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback — Phase 8 standard):
-- Re-applying 20260721000002's CREATE OR REPLACE body would restore the
-- UTC-bucketing bug this migration fixes, so there is no safe DOWN other
-- than re-running that prior migration's body verbatim. Documented here
-- rather than scripted to avoid accidentally reintroducing the timezone bug.
-- =============================================================================
