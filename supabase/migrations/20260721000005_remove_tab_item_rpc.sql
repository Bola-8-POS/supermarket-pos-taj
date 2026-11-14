-- =============================================================================
-- Phase 24 Plan 04 Task 1 — remove_tab_item audited RPC (D-06, D-07)
--
-- Replaces useRemoveTabItem's 3-step client mutation (delete order_item ->
-- check remaining -> conditionally void order) plus its long-standing
-- inventory-restore TODO with a single atomic RPC:
--   1. Capture before-state (order_item row + order_id).
--   2. Restore inventory via the existing generic deplete_for_order_item
--      (p_direction = -1, p_allow_negative = true) BEFORE the row is
--      deleted -- it reads product_id/quantity/modifier_ids from the row
--      by id and silently no-ops if the row is already gone.
--   3. Hard-delete the order_item.
--   4. Void the parent order if no items remain.
--   5. PERFORM record_audit('order_item.remove', ...) on the success path
--      only -- closes the last un-audited destructive order-lifecycle
--      mutation (T-24-04-R).
--
-- Deliberately does NOT add a manager/admin role gate (D-07, Pitfall 3):
-- item removal stays bartender-accessible, matching useRemoveTabItem's
-- current effective access level. Do not copy edit_paid_tab's role check.
--
-- Includes a lightweight defense-in-depth TAB_NOT_OPEN guard (RESEARCH.md
-- Open Question 2) -- only open tabs can have items removed.
--
-- Depends on:
--   - src/shared/lib/audit-actions.ts already registers 'order_item.remove' (24-01)
--   - 20260707000001_deplete_for_order_item_v4_fix_modifier_ingredient_collision.sql
--   - 20260511000001_audit_logs_table.sql (record_audit helper)
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION public.remove_tab_item(p_item_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_before jsonb;
  v_remaining int;
  v_tab_status tab_status;
BEGIN
  -- 1. Capture before-state (id/product_id/quantity/modifier_ids/etc.) +
  -- the owning order_id, in one shot -- avoids a second lookup after the
  -- row is gone.
  SELECT to_jsonb(oi.*), oi.order_id INTO v_before, v_order_id
  FROM order_items oi WHERE oi.id = p_item_id;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Defense-in-depth: only open tabs are eligible for item removal.
  SELECT t.status INTO v_tab_status
  FROM tabs t JOIN orders o ON o.id = v_order_id WHERE t.id = o.tab_id;

  IF v_tab_status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TAB_NOT_OPEN');
  END IF;

  -- 2. Restore inventory BEFORE deleting -- deplete_for_order_item reads
  -- product_id/quantity/modifier_ids from the still-present row.
  PERFORM deplete_for_order_item(p_item_id, -1, true);

  -- 3. Hard-delete the order_item.
  DELETE FROM order_items WHERE id = p_item_id;

  -- 4. Void the parent order if no items remain.
  SELECT COUNT(*) INTO v_remaining FROM order_items WHERE order_id = v_order_id;
  IF v_remaining = 0 THEN
    UPDATE orders SET status = 'voided' WHERE id = v_order_id;
  END IF;

  -- 5. Audit -- success path ONLY (mirrors edit_paid_tab: a raised exception
  -- rolls back the whole transaction including any audit insert attempted
  -- after it, so this must never sit inside an EXCEPTION block).
  PERFORM record_audit('order_item.remove', 'order_item', p_item_id, v_before,
    jsonb_build_object('reason', p_reason), 'rpc');

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_tab_item(uuid, text) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN (manual, Supabase Cloud has no automated rollback -- Phase 8 standard):
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.remove_tab_item(uuid, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.remove_tab_item(uuid, text);
-- COMMIT;
-- =============================================================================
