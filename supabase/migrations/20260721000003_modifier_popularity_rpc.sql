-- =============================================================================
-- Phase 24 Plan 03 Task 2: modifier-popularity bounded report RPC (D-09)
--
-- Ranks modifiers by attach-count + revenue-attributable. CRITICAL (RESEARCH.md
-- Pitfall 4): unnest(modifier_ids) MUST be aggregated in an isolated CTE
-- BEFORE joining to the modifiers table — a flat join of order_items to
-- modifiers via an unnested array double-counts rows whenever an order_item
-- carries more than one modifier. The `exploded` CTE below performs the
-- unnest + row expansion; `aggregated` performs GROUP BY modifier_id on the
-- expanded rows; only then does the outer query join to `modifiers` for
-- names. Returns ALL modifier rows uncapped (top-20 cap is UI-only, D-10 —
-- CSV/Excel export must see the full data).
--
-- NOT pushed here — the single BLOCKING `npx supabase db push` is Plan 05.
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION get_modifier_popularity_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  WITH exploded AS (
    SELECT unnest(modifier_ids) AS modifier_id
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status <> 'voided'
      AND o.is_deleted = FALSE
      AND oi.is_deleted = FALSE
      AND o.created_at BETWEEN p_from AND p_to
      AND array_length(modifier_ids, 1) > 0
  ),
  aggregated AS (
    SELECT modifier_id, COUNT(*) AS attach_count
    FROM exploded
    GROUP BY modifier_id
  )
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT
      m.id AS "modifierId",
      m.name AS "modifierName",
      a.attach_count AS "attachCount",
      (a.attach_count * m.price_delta) AS revenue
    FROM aggregated a
    JOIN modifiers m ON m.id = a.modifier_id
    ORDER BY a.attach_count DESC
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_modifier_popularity_report(timestamptz, timestamptz) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- Function is new. Rollback = drop it:
--   DROP FUNCTION IF EXISTS get_modifier_popularity_report(timestamptz, timestamptz);
-- =============================================================================
