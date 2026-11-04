-- =============================================================================
-- Phase 20 Plan 03: evaluate_promotions_for_item() + create_order_with_items v3
--
-- This migration introduces the FIRST server-side pricing authority in this
-- codebase (RESEARCH Summary + Pitfall 1). From here on, the client-supplied
-- unit_price sent to create_order_with_items is treated as the UNDISCOUNTED
-- base price input for promotion-eligible items; evaluate_promotions_for_item
-- is the sole writer of the final, charged order_items.unit_price for those
-- items.
--
-- Implements:
--   D-02 — silent auto-apply, no cashier confirmation
--   D-03 — stacking via sequential compounding in admin-set priority order
--   D-04 — the three discount shapes (percentage / fixed_amount / fixed_price)
--
-- Combo exclusion (Pitfall 6): combo parent items (products.is_combo = true)
-- and combo child items (order_items.combo_slot_id IS NOT NULL) are excluded
-- via an early RETURN — no promotion evaluation, no $0 audit noise. Combo +
-- promotion interaction is explicitly out of scope for this phase.
--
-- Only target_type IN ('item', 'category') is matched here. 'pool_billing'
-- and 'pool_grant' are intentionally NOT matched by this function's WHERE
-- clause — Plan 20-05 adds those two evaluation paths separately.
--
-- create_order_with_items v3 supersedes the v2/Phase-15 body
-- (20260512000002_rpc_versioned_group_a.sql): SAME 7-arg signature, SAME
-- SECURITY INVOKER, SAME p_expected_version FOR UPDATE guard, SAME depletion
-- loop — the only change is one new PERFORM call inside the existing
-- per-item loop, immediately after deplete_for_order_item. The RPC's return
-- payload's unit_price now reflects the post-evaluation discounted price for
-- any item(s) with an eligible promotion.
--
-- Depends on:
--   - 20260710000001_promotions_schema.sql (promotions table)
--   - 20260710000002_is_promotion_available_fn.sql (is_promotion_available)
--   - 20260710000003_applied_promotions_table.sql (applied_promotions table)
--   - 20260512000002_rpc_versioned_group_a.sql (current create_order_with_items body)
--   - 20260703000001_record_audit_terminal_id.sql (record_audit current 8-arg signature)
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. evaluate_promotions_for_item(uuid) — SECURITY DEFINER
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION evaluate_promotions_for_item(p_order_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
  v_category_id uuid;
  v_base_price numeric;
  v_tab_id uuid;
  v_is_combo boolean;
  v_combo_slot_id uuid;
  v_running_price numeric;
  v_original numeric;
  v_applied_any boolean := false;
  v_promo record;
BEGIN
  SELECT
    oi.product_id,
    p.category_id,
    oi.unit_price,
    o.tab_id,
    p.is_combo,
    oi.combo_slot_id
  INTO
    v_product_id,
    v_category_id,
    v_base_price,
    v_tab_id,
    v_is_combo,
    v_combo_slot_id
  FROM order_items oi
  JOIN products p ON p.id = oi.product_id
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Pitfall 6: combo parent + combo child lines are excluded from promotion
  -- evaluation entirely — no evaluation, no $0 audit noise.
  IF v_is_combo IS TRUE OR v_combo_slot_id IS NOT NULL THEN
    RETURN;
  END IF;

  v_running_price := v_base_price;

  FOR v_promo IN
    SELECT p.*
    FROM promotions p
    WHERE p.is_active
      AND (
        (p.target_type = 'item' AND p.target_product_id = v_product_id)
        OR (p.target_type = 'category' AND p.target_category_id = v_category_id)
      )
      AND is_promotion_available(p.id, now())
    ORDER BY p.priority ASC, p.created_at ASC, p.id ASC
  LOOP
    v_original := v_running_price;

    CASE v_promo.discount_type
      WHEN 'percentage' THEN
        v_running_price := GREATEST(0, ROUND(v_running_price * (1 - v_promo.discount_value / 100), 2));
      WHEN 'fixed_amount' THEN
        v_running_price := GREATEST(0, ROUND(v_running_price - v_promo.discount_value, 2));
      WHEN 'fixed_price' THEN
        v_running_price := v_promo.discount_value;
      ELSE
        CONTINUE;
    END CASE;

    v_applied_any := true;

    INSERT INTO applied_promotions (
      promotion_id,
      promotion_name_snapshot,
      target_type,
      discount_type,
      discount_value,
      tab_id,
      order_item_id,
      original_amount,
      discounted_amount
    ) VALUES (
      v_promo.id,
      v_promo.name,
      v_promo.target_type,
      v_promo.discount_type,
      v_promo.discount_value,
      v_tab_id,
      p_order_item_id,
      v_original,
      v_running_price
    );
  END LOOP;

  IF v_applied_any THEN
    UPDATE order_items SET unit_price = v_running_price WHERE id = p_order_item_id;

    PERFORM record_audit(
      'promotion.apply',
      'applied_promotion',
      p_order_item_id,
      NULL,
      jsonb_build_object(
        'orderItemId', p_order_item_id,
        'originalAmount', v_base_price,
        'discountedAmount', v_running_price
      ),
      'rpc',
      NULL
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION evaluate_promotions_for_item(uuid) TO authenticated;

-- -----------------------------------------------------------------------
-- 2. create_order_with_items v3 — same signature/guard/depletion loop as v2
--    (20260512000002_rpc_versioned_group_a.sql), plus one new PERFORM call.
--    NOTE: the returned items' unit_price now reflects the post-evaluation
--    discounted price for any promotion-eligible item.
-- -----------------------------------------------------------------------
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
  IF NOT p_skip_depletion THEN
    FOR v_inserted_item IN
      SELECT id FROM order_items WHERE order_id = v_order.id
    LOOP
      PERFORM deplete_for_order_item(v_inserted_item.id, 1::smallint);
      -- Phase 20: server-side promotion evaluation (item/category only).
      -- Sole authority for order_items.unit_price on promotion-eligible items.
      PERFORM evaluate_promotions_for_item(v_inserted_item.id);
    END LOOP;
  END IF;

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
-- DROP FUNCTION IF EXISTS evaluate_promotions_for_item(uuid);
-- Restoring the prior create_order_with_items body requires re-applying
-- 20260512000002_rpc_versioned_group_a.sql (removes the
-- PERFORM evaluate_promotions_for_item(...) line).
-- COMMIT;
-- =============================================================================
