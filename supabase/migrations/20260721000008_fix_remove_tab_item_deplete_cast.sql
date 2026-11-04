-- =============================================================================
-- Phase 24 Plan 10: fix remove_tab_item -> deplete_for_order_item signature
-- mismatch (discovered by the bartender-removal E2E test)
--
-- remove_tab_item (20260721000005) called:
--   PERFORM deplete_for_order_item(p_item_id, -1, true);
-- deplete_for_order_item's p_direction parameter is `smallint`
-- (20260707000001_deplete_for_order_item_v4_fix_modifier_ingredient_collision.sql).
-- An untyped integer literal (`-1`) defaults to Postgres's `integer` type, and
-- int4 -> int2 is only an assignment cast (not implicit), so Postgres's
-- function-overload resolution could not find a match at call time. Every
-- remove_tab_item call failed with:
--   42883 "function deplete_for_order_item(uuid, integer, boolean) does not
--   exist"
-- surfaced through PostgREST as an HTTP 404 on POST /rest/v1/rpc/remove_tab_item.
--
-- Fix: explicit ::smallint cast on the literal. Everything else unchanged
-- (verbatim copy of 20260721000005's body).
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
  -- Cast to smallint: deplete_for_order_item's p_direction is smallint, and
  -- int4->int2 is only an assignment cast (not implicit) in Postgres, so an
  -- unqualified `-1` integer literal fails overload resolution (42883).
  PERFORM deplete_for_order_item(p_item_id, (-1)::smallint, true);

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
-- Restore the pre-fix (broken) body is not useful; rollback = drop the function:
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.remove_tab_item(uuid, text) FROM authenticated;
-- DROP FUNCTION IF EXISTS public.remove_tab_item(uuid, text);
-- COMMIT;
-- =============================================================================
