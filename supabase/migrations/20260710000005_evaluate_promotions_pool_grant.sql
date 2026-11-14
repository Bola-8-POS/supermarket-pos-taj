-- =============================================================================
-- Phase 20 Plan 05: evaluate_promotions_for_item v2 — pool_grant branch (D-05b)
--
-- CREATE OR REPLACES evaluate_promotions_for_item(uuid), keeping the v1 body
-- (20260710000004_evaluate_promotions_rpc.sql) VERBATIM — same combo
-- early-return, same item/category price-compounding loop and unit_price
-- write — then appends a SECOND loop for `pool_grant`-targeted promotions.
--
-- pool_grant semantics: purchasing a product/category targeted by an active
-- pool_grant promotion records an UNCONSUMED bonus pool-minute grant
-- (applied_promotions.pool_minutes_granted = discount_value::int,
-- consumed_at = NULL) — it does NOT touch order_items.unit_price. The grant
-- is consumed later by Plan 20-05 Task 2's stop_pool_session RPC, which sums
-- unconsumed grants for the tab and deducts them as prepaid minutes before
-- block-rounding, then marks them consumed_at = now().
--
-- Combo exclusion (Pitfall 6) applies identically to the pool_grant loop —
-- the same early RETURN above both loops covers it, so no separate check is
-- needed here.
--
-- Depends on:
--   - 20260710000004_evaluate_promotions_rpc.sql (v1 body being replaced)
--   - 20260710000003_applied_promotions_table.sql (pool_minutes_granted / consumed_at columns)
-- =============================================================================

-- UP:
BEGIN;

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
  v_grant record;
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
  -- evaluation entirely — no evaluation, no $0 audit noise. Applies to BOTH
  -- the price loop and the pool_grant loop below.
  IF v_is_combo IS TRUE OR v_combo_slot_id IS NOT NULL THEN
    RETURN;
  END IF;

  v_running_price := v_base_price;

  -- ---------------------------------------------------------------------
  -- Loop 1 (v1, unchanged): item/category price-discount promotions.
  -- ---------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------
  -- Loop 2 (Phase 20 Plan 05 / D-05b, NEW): pool_grant bonus-minute grants.
  -- Does NOT touch unit_price. Records one unconsumed grant row per
  -- matching, active, available pool_grant promotion.
  -- ---------------------------------------------------------------------
  FOR v_grant IN
    SELECT p.*
    FROM promotions p
    WHERE p.is_active
      AND p.target_type = 'pool_grant'
      AND (
        (p.target_product_id = v_product_id)
        OR (p.target_category_id = v_category_id)
      )
      AND is_promotion_available(p.id, now())
  LOOP
    INSERT INTO applied_promotions (
      promotion_id,
      promotion_name_snapshot,
      target_type,
      discount_type,
      discount_value,
      tab_id,
      order_item_id,
      pool_minutes_granted,
      consumed_at
    ) VALUES (
      v_grant.id,
      v_grant.name,
      'pool_grant',
      NULL,
      v_grant.discount_value,
      v_tab_id,
      p_order_item_id,
      v_grant.discount_value::int,
      NULL
    );

    PERFORM record_audit(
      'promotion.apply',
      'applied_promotion',
      p_order_item_id,
      NULL,
      jsonb_build_object('poolMinutesGranted', v_grant.discount_value),
      'rpc',
      NULL
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION evaluate_promotions_for_item(uuid) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- Restoring the prior (v1, item/category-only) body requires re-applying
-- 20260710000004_evaluate_promotions_rpc.sql (removes the pool_grant loop).
-- COMMIT;
-- =============================================================================
