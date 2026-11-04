-- UP
-- Phase 8 S6-01: reporting views for combo mix, recipe variance, waitlist analytics

-- 1. combo_mix_daily: daily combo sales aggregated from order_items + audit_log
CREATE OR REPLACE VIEW combo_mix_daily AS
SELECT
  date_trunc('day', o.created_at AT TIME ZONE 'America/Mexico_City')::date AS date,
  oi.product_id                                                              AS combo_product_id,
  p.name                                                                     AS combo_name,
  COUNT(oi.id)::int                                                          AS qty_sold,
  SUM(oi.unit_price * oi.quantity)::numeric(12,2)                           AS net_revenue,
  AVG(oi.unit_price)::numeric(10,2)                                         AS avg_price,
  COUNT(al.id)::int                                                           AS override_count
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN products p ON p.id = oi.product_id
LEFT JOIN audit_log al
  ON al.entity_type = 'combo'
  AND al.entity_id = oi.product_id
  AND al.action = 'combo_availability_override'
  AND date_trunc('day', al.created_at) = date_trunc('day', o.created_at)
WHERE p.is_combo = true
  AND o.status != 'voided'
GROUP BY 1, 2, 3;

-- 2. recipe_variance_daily: ingredient theoretical vs physical count variance
CREATE OR REPLACE VIEW recipe_variance_daily AS
SELECT
  date_trunc('day', sm.created_at AT TIME ZONE 'America/Mexico_City')::date AS date,
  sm.ingredient_id,
  i.name                                                              AS ingredient_name,
  ABS(SUM(sm.quantity_delta) FILTER (WHERE sm.reason = 'sale'))::numeric      AS theoretical_used,
  ABS(SUM(sm.quantity_delta) FILTER (WHERE sm.reason = 'physical_count'))::numeric AS physical_delta,
  CASE
    WHEN ABS(SUM(sm.quantity_delta) FILTER (WHERE sm.reason = 'sale')) = 0 THEN 0
    ELSE ROUND(
      (ABS(SUM(sm.quantity_delta) FILTER (WHERE sm.reason = 'physical_count'))
       - ABS(SUM(sm.quantity_delta) FILTER (WHERE sm.reason = 'sale')))
      / NULLIF(ABS(SUM(sm.quantity_delta) FILTER (WHERE sm.reason = 'sale')), 0) * 100,
      2
    )
  END                                                                AS variance_pct
FROM stock_movements sm
JOIN ingredients i ON i.id = sm.ingredient_id
WHERE sm.ingredient_id IS NOT NULL
GROUP BY 1, 2, 3;

-- 3. waitlist_metrics_daily: daily waitlist funnel metrics
-- quoted_wait_minutes column not present in schema; returning NULL until column is added
CREATE OR REPLACE VIEW waitlist_metrics_daily AS
SELECT
  date_trunc('day', created_at AT TIME ZONE 'America/Mexico_City')::date AS date,
  COUNT(*) FILTER (WHERE status = 'seated')::int                          AS parties_seated,
  -- quoted_wait_minutes column not present in schema; returning NULL until column is added
  NULL::numeric                                                            AS avg_quoted_wait,
  ROUND(AVG(
    EXTRACT(EPOCH FROM (seated_at - created_at)) / 60
  ) FILTER (WHERE status = 'seated' AND seated_at IS NOT NULL), 1)       AS avg_actual_wait,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'no_show')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE status IN ('seated', 'no_show')), 0) * 100,
    1
  )                                                                        AS no_show_rate
FROM waitlist_entries
GROUP BY 1;

-- DOWN:
-- BEGIN;
-- DROP VIEW IF EXISTS waitlist_metrics_daily;
-- DROP VIEW IF EXISTS recipe_variance_daily;
-- DROP VIEW IF EXISTS combo_mix_daily;
-- COMMIT;
