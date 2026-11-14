-- =============================================================================
-- Phase 20 Plan 09 (Task 3 gap-closure): fix create_order_with_items v4 —
-- decouple promotion evaluation from p_skip_depletion.
--
-- BUG (found during Plan 20-09's UAT gate, confirmed by 2 failing live
-- integration tests: evaluate-promotions-rpc.integration.test.ts and
-- pool-promotions-rpc.integration.test.ts's pool_grant case):
--
-- create_order_with_items v3 (20260710000004_evaluate_promotions_rpc.sql)
-- placed `PERFORM evaluate_promotions_for_item(...)` inside the SAME
-- `IF NOT p_skip_depletion THEN ... END IF;` block as
-- `PERFORM deplete_for_order_item(...)`. Ingredient depletion and promotion
-- pricing are two independent concerns that got coupled to one conditional.
-- Any order placed with p_skip_depletion:true (the manager-PIN "override
-- negative stock" path — src/features/override-negative-stock) received
-- ZERO promotion evaluation, silently overcharging the customer relative to
-- what the cart/banner implied.
--
-- FIX: create_order_with_items v4 keeps depletion gated on
-- `NOT p_skip_depletion` (unchanged behavior — skip-depletion orders still
-- skip depletion) but runs `evaluate_promotions_for_item` UNCONDITIONALLY
-- for every inserted order item, regardless of p_skip_depletion. Same
-- 7-arg signature, same SECURITY INVOKER, same p_expected_version FOR
-- UPDATE guard — CREATE OR REPLACE, additive migration, no schema break.
--
-- Depends on:
--   - 20260710000004_evaluate_promotions_rpc.sql (v3 body being replaced)
--   - 20260710000005_evaluate_promotions_pool_grant.sql (current
--     evaluate_promotions_for_item body — untouched by this migration)
-- =============================================================================

-- UP:
BEGIN;

CREATE OR REPLACE FUNCTION public.create_order_with_items(
  p_tab_id uuid,
  p_staff_id uuid,
  p_status order_status,
  p_notes text,
  p_items jsonb,
  p_skip_depletion boolean DEFAULT false,
  p_expected_version int DEFAULT NULL
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
  v_current int;
BEGIN
  -- Phase 15: lock tab row + assert expected_version (canonical guard).
  SELECT version INTO v_current FROM tabs WHERE id = p_tab_id FOR UPDATE;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND_VERSIONED' USING ERRCODE = 'P0V02';
  END IF;
  IF p_expected_version IS NOT NULL AND v_current <> p_expected_version THEN
    RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'P0V01';
  END IF;

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
  -- Phase 20 fix (this migration): promotion evaluation is an INDEPENDENT
  -- concern from depletion and now runs unconditionally below, for every
  -- inserted item, regardless of p_skip_depletion.
  IF NOT p_skip_depletion THEN
    FOR v_inserted_item IN
      SELECT id FROM order_items WHERE order_id = v_order.id
    LOOP
      PERFORM deplete_for_order_item(v_inserted_item.id, 1::smallint);
    END LOOP;
  END IF;

  -- Phase 20: server-side promotion evaluation (item/category/pool_grant).
  -- Sole authority for order_items.unit_price on promotion-eligible items.
  -- Runs for EVERY inserted item regardless of p_skip_depletion — pricing
  -- and depletion are orthogonal concerns (this migration's fix).
  FOR v_inserted_item IN
    SELECT id FROM order_items WHERE order_id = v_order.id
  LOOP
    PERFORM evaluate_promotions_for_item(v_inserted_item.id);
  END LOOP;

  -- Phase 15: bump tabs.version after successful insert. The
  -- bump_version_on_update trigger enforces exact +1 advancement.
  UPDATE tabs SET version = version + 1, updated_at = NOW() WHERE id = p_tab_id;

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

GRANT EXECUTE ON FUNCTION public.create_order_with_items(uuid, uuid, order_status, text, jsonb, boolean, int) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- Restoring the prior (v3, promotion-evaluation-gated-on-p_skip_depletion)
-- body requires re-applying 20260710000004_evaluate_promotions_rpc.sql's
-- create_order_with_items definition (moves the PERFORM
-- evaluate_promotions_for_item(...) call back inside the
-- IF NOT p_skip_depletion THEN ... END IF; block).
-- COMMIT;
-- =============================================================================
