-- =============================================================================
-- Phase 24 Plan 04 Task 2 — deletions-pre + deletions-post report RPCs (D-05)
--
-- Two bounded, SECURITY DEFINER report RPCs reading the plural audit_logs
-- table (never the legacy Phase-8 singular-named table -- Pitfall 1) at the
-- two financial-risk stages of a destructive tab edit:
--
--   get_deletions_pre_report:  action = 'order_item.remove' (remove_tab_item,
--     this plan's Task 1) -- pre-send item removal.
--   get_deletions_post_report: action = 'tab.edit_paid' (edit_paid_tab,
--     Phase 22) -- post-close correction.
--
-- Both bounded on audit_logs.created_at BETWEEN p_from AND p_to (SC-4),
-- json_build_object('ok', true, 'rows', ...) return shape matching every
-- other report RPC in this phase.
--
-- Depends on:
--   - 20260511000001_audit_logs_table.sql (audit_logs table)
--   - 20260721000005_remove_tab_item_rpc.sql (this plan's Task 1, writes
--     'order_item.remove' audit rows)
--   - 20260719000001_edit_paid_tab_rpc.sql (writes 'tab.edit_paid' audit rows)
--
-- NOT pushed here -- the single BLOCKING `npx supabase db push` is Plan 05.
-- =============================================================================

-- UP:
BEGIN;

-- Variant A: pre-send order-item removal (remove_tab_item).
-- itemName resolved via products join on the before-state's product_id --
-- order_items has no name-snapshot column, and the product row itself is
-- never deleted by removal.
CREATE OR REPLACE FUNCTION get_deletions_pre_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT
      (al.before->>'order_id')::uuid AS "orderId",
      COALESCE(p.name, '') AS "itemName",
      al.created_at AS "removedAt",
      COALESCE(pr.name, '') AS "staffName",
      COALESCE(al.after->>'reason', '') AS reason
    FROM audit_logs al
    LEFT JOIN profiles pr ON pr.id = al.actor_id
    LEFT JOIN products p ON p.id = (al.before->>'product_id')::uuid
    WHERE al.action = 'order_item.remove'
      AND al.created_at BETWEEN p_from AND p_to
    ORDER BY al.created_at DESC
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_deletions_pre_report(timestamptz, timestamptz) TO authenticated;

-- Variant B: post-close correction (edit_paid_tab). fieldsChanged is derived
-- by diffing the before/after tab-row jsonb top-level keys, excluding
-- 'updated_at'/'version' (always change) and 'items' (nested order_items
-- array, not a scalar tab field).
CREATE OR REPLACE FUNCTION get_deletions_post_report(p_from timestamptz, p_to timestamptz)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO v_rows
  FROM (
    SELECT
      al.entity_id AS "tabId",
      al.created_at AS "editedAt",
      COALESCE(pr.name, '') AS "staffName",
      COALESCE(al.after->>'reason', '') AS reason,
      COALESCE((
        SELECT array_agg(key)
        FROM jsonb_object_keys(al.before) AS key
        WHERE key NOT IN ('updated_at', 'version', 'items')
          AND al.before->key IS DISTINCT FROM al.after->key
      ), ARRAY[]::text[]) AS "fieldsChanged"
    FROM audit_logs al
    LEFT JOIN profiles pr ON pr.id = al.actor_id
    WHERE al.action = 'tab.edit_paid'
      AND al.created_at BETWEEN p_from AND p_to
    ORDER BY al.created_at DESC
  ) t;
  RETURN json_build_object('ok', true, 'rows', COALESCE(v_rows, '[]'::json));
END; $$;

GRANT EXECUTE ON FUNCTION get_deletions_post_report(timestamptz, timestamptz) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- Both functions are new (no prior CREATE OR REPLACE generation exists).
-- Rollback = drop the functions:
--   DROP FUNCTION IF EXISTS get_deletions_pre_report(timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS get_deletions_post_report(timestamptz, timestamptz);
-- =============================================================================
