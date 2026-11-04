-- =============================================================================
-- Phase 4: create_order_with_items v2 — adds p_skip_depletion + depletion loop
--
-- Extends the original create_order_with_items RPC with:
--   p_skip_depletion boolean DEFAULT false — when true, no ingredient depletion
--     is called (manager override path; depletion is called separately by the
--     override hook after stock check passes).
--
-- The depletion loop calls deplete_for_order_item(item_id, 1::smallint) for each
-- inserted order_item within the same transaction. INVENTORY_NEGATIVE propagates
-- up and rolls back the entire order (atomicity preserved — T-04-05 mitigation).
--
-- Depends on:
--   - 20260428000002_deplete_for_order_item.sql (deplete_for_order_item v1)
-- =============================================================================

-- UP:
CREATE OR REPLACE FUNCTION public.create_order_with_items(
  p_tab_id uuid,
  p_staff_id uuid,
  p_status order_status,
  p_notes text,
  p_items jsonb,
  p_skip_depletion boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_items jsonb;
  v_inserted_item record;
BEGIN
  INSERT INTO orders (tab_id, staff_id, status, notes)
  VALUES (p_tab_id, p_staff_id, p_status, p_notes)
  RETURNING * INTO v_order;

  INSERT INTO order_items (
    order_id,
    product_id,
    quantity,
    unit_price,
    modifier_ids,
    modifier_price_delta,
    notes
  )
  SELECT
    v_order.id,
    (elem->>'product_id')::uuid,
    COALESCE((elem->>'quantity')::int, 1),
    (elem->>'unit_price')::numeric,
    COALESCE(
      (
        SELECT array_agg(value::uuid)
        FROM jsonb_array_elements_text(COALESCE(elem->'modifier_ids', '[]'::jsonb)) AS t(value)
      ),
      ARRAY[]::uuid[]
    ),
    COALESCE((elem->>'modifier_price_delta')::numeric, 0),
    NULLIF(elem->>'notes', '')
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) AS elem;

  -- Phase 4: Deplete ingredients for each order item (same transaction).
  -- Skip when p_skip_depletion=true (manager override path — depletion called separately).
  IF NOT p_skip_depletion THEN
    FOR v_inserted_item IN
      SELECT id FROM order_items WHERE order_id = v_order.id
    LOOP
      PERFORM deplete_for_order_item(v_inserted_item.id, 1::smallint);
    END LOOP;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(oi.*)), '[]'::jsonb)
  INTO v_items
  FROM order_items oi
  WHERE oi.order_id = v_order.id;

  RETURN jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_order_with_items(uuid, uuid, order_status, text, jsonb, boolean) TO authenticated;

-- =============================================================================
-- DOWN:
-- DROP FUNCTION IF EXISTS public.create_order_with_items(uuid, uuid, order_status, text, jsonb, boolean);
-- Restore original 5-arg version from 20260416120000_create_order_with_items_rpc.sql
-- =============================================================================
