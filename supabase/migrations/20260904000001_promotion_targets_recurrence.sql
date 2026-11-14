-- =============================================================================
-- Phase 28 Plan 01: Promotion Management Redesign — schema breaking change.
--
-- Replaces promotions.scope_type/product_id/category_id (singular FK columns
-- + promotions_exactly_one_target XOR CHECK) with a promotion_targets
-- junction table: 0 rows = store-wide, N rows = multi-product/multi-category
-- (D-01/D-02). Adds day-of-week/time-of-day recurrence columns as an
-- additional AND-filter on top of the existing starts_at/ends_at date range
-- (D-03..D-06), and a needs_review flag backfilled true on every
-- pre-existing row so migrated promotions are visibly distinguishable from
-- newly-created ones (D-11/D-12).
--
-- Root cause / design doc: .planning/phases/28-promotion-management-redesign/28-CONTEXT.md,
-- .planning/phases/28-promotion-management-redesign/28-RESEARCH.md ("Code Examples").
--
-- This repo has no DOWN-script convention (CLAUDE.md) — reverting this
-- migration means writing a new forward migration, not rolling back.
--
-- Scope: this migration touches ONLY the promotions/promotion_targets schema
-- and process_direct_sale_atomic's candidate-pool matching + recurrence
-- filter. Everything else in that function body (item-price validation,
-- floor guard, ad-hoc discount, manager-PIN re-verify) is copied verbatim
-- from 20260903090000_process_direct_sale_manager_pin_reverify.sql, the
-- current live definition, unchanged.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. promotion_targets junction table (D-01/D-02)
-- -----------------------------------------------------------------------------

CREATE TABLE promotion_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_targets_exactly_one_ref CHECK (
    (product_id IS NOT NULL) <> (category_id IS NOT NULL)
  )
);

-- Partial unique indexes, NOT a composite UNIQUE constraint — NULL
-- distinctness would defeat a plain UNIQUE(promotion_id, product_id,
-- category_id): two rows sharing the same NULL column never violate it.
CREATE UNIQUE INDEX idx_promotion_targets_unique_product
  ON promotion_targets (promotion_id, product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX idx_promotion_targets_unique_category
  ON promotion_targets (promotion_id, category_id) WHERE category_id IS NOT NULL;

CREATE INDEX idx_promotion_targets_promotion ON promotion_targets (promotion_id);
CREATE INDEX idx_promotion_targets_product ON promotion_targets (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_promotion_targets_category ON promotion_targets (category_id) WHERE category_id IS NOT NULL;

ALTER TABLE promotion_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY promotion_targets_select_authenticated ON promotion_targets FOR SELECT TO authenticated USING (true);
CREATE POLICY promotion_targets_manage ON promotion_targets FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_promotions'))
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_promotions'));

-- -----------------------------------------------------------------------------
-- 2. Backfill existing rows into promotion_targets BEFORE dropping the
--    singular columns (D-11 — neither environment has live promotion usage
--    yet, but the migration still performs this in case of any dev rows).
-- -----------------------------------------------------------------------------

INSERT INTO promotion_targets (promotion_id, product_id)
SELECT id, product_id FROM promotions WHERE product_id IS NOT NULL;

INSERT INTO promotion_targets (promotion_id, category_id)
SELECT id, category_id FROM promotions WHERE category_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. Recurrence columns + needs_review column + drop the old scope columns
--    (D-01/D-02/D-04/D-05). ADD and DROP happen together in one ALTER TABLE
--    statement (Postgres applies both atomically), so the needs_review
--    backfill below necessarily runs after this — but every row still in
--    the table at that point is, by construction, a row that existed prior
--    to this migration (a brand-new migration cannot have created rows
--    before it ran), so the backfill semantics (D-12: every pre-existing
--    row visibly flagged) hold exactly as intended.
-- -----------------------------------------------------------------------------

-- Deviation (Rule 1 auto-fix, discovered applying this migration locally):
-- promotions_exactly_one_target CHECK references both product_id and
-- category_id, so dropping either column auto-drops the dependent CHECK
-- constraint (Postgres implicit-dependency behavior — no CASCADE keyword
-- needed for a same-statement column drop). An explicit trailing
-- `DROP CONSTRAINT promotions_exactly_one_target` after the column drops
-- errors with "constraint ... does not exist" because it is already gone
-- by the time that sub-clause runs. Omit the explicit DROP CONSTRAINT.
ALTER TABLE promotions
  ADD COLUMN days_of_week int[],
  ADD COLUMN start_time time,
  ADD COLUMN end_time time,
  ADD COLUMN needs_review boolean NOT NULL DEFAULT false,
  DROP COLUMN scope_type,
  DROP COLUMN product_id,
  DROP COLUMN category_id;

-- -----------------------------------------------------------------------------
-- 4. needs_review backfill (D-12) — marks every promotion that existed
--    prior to this migration. New rows created after this migration default
--    to needs_review = false via the column DEFAULT above — no further
--    action needed for the ongoing case.
-- -----------------------------------------------------------------------------

UPDATE promotions SET needs_review = true;

ALTER TABLE promotions ADD CONSTRAINT promotions_recurrence_both_or_neither CHECK (
  (start_time IS NULL) = (end_time IS NULL)
);
ALTER TABLE promotions ADD CONSTRAINT promotions_recurrence_same_day CHECK (
  start_time IS NULL OR start_time < end_time
);
ALTER TABLE promotions ADD CONSTRAINT promotions_days_of_week_valid CHECK (
  days_of_week IS NULL OR days_of_week <@ ARRAY[0,1,2,3,4,5,6]
);

-- Old scope-based indexes referenced dropped columns and are gone with them
-- automatically (idx_promotions_product_active / idx_promotions_category_active).

-- -----------------------------------------------------------------------------
-- 5. process_direct_sale_atomic — extend the candidate-pool scope match to
--    the junction table + add the recurrence AND-filter (D-03..D-06).
--    EXACT same 19-parameter signature as the current live definition in
--    20260903093000_manager_override_null_coalesce_guard.sql (the truly
--    latest body — supersedes 20260903090000, which the plan's read_first
--    cited but which 093000 further modified with the NULL-coalesce guard
--    and manager-override/pin forwarding through the payment delegation
--    calls; both preserved here, deviation Rule 1) — only the DECLARE block
--    (new v_store_tz) and the candidate-pool SELECT change.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.process_direct_sale_atomic(p_staff_id uuid, p_shift_id uuid, p_caja_session_id uuid, p_items jsonb, p_idempotency_key text, p_method text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_legs jsonb DEFAULT NULL::jsonb, p_expected_total numeric DEFAULT NULL::numeric, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_customer_name text DEFAULT 'Walk-in'::text, p_customer_phone text DEFAULT NULL::text, p_manager_override boolean DEFAULT false, p_manager_pin text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_payment_id uuid; v_existing_tab_id uuid; v_existing_group_id uuid; v_existing_payment_ids uuid[];
  v_existing_staff_id uuid; v_existing_shift_id uuid; v_existing_caja_id uuid;
  v_catalog_price numeric; v_expected_price numeric; v_sold_by_weight boolean; v_weight_grams integer;
  v_cost_price numeric; v_elem jsonb; v_tab_id uuid; v_order_id uuid; v_result jsonb;
  v_modifier_ids uuid[]; v_modifier_delta numeric; v_line_qty int;
  v_subtotal numeric := 0; v_tax_rate numeric; v_tax numeric; v_derived_total numeric;
  v_tax_inclusive boolean;
  v_derived_items jsonb := '[]'::jsonb;
  -- Phase 27: promotions + floor guard.
  v_category_id uuid;
  v_expiry_date date;
  v_near_expiry_threshold int;
  v_near_expiry_discount_pct numeric;
  v_cand_id uuid; v_cand_rate numeric; v_cand_created_at timestamptz; v_cand_amount numeric;
  v_expiry_amount numeric;
  v_promo_id uuid; v_promo_rate numeric;
  v_line_discount numeric;
  v_line_price numeric;
  v_adhoc_discount numeric;
  -- Phase 27 Plan 08 (G-27-13): resolved from p_manager_pin, independent of p_staff_id.
  v_manager_staff_id uuid;
  -- Phase 28: recurrence AND-filter (D-03..D-06) — store-local timezone,
  -- fetched once, same double-COALESCE fallback pattern as
  -- v_near_expiry_threshold below.
  v_store_tz text;
BEGIN
  -- Phase 27 gap-closure code review (CR-01/CR-02), carried forward from
  -- 20260903093000: coalesce a stray SQL NULL to false so a caller that
  -- omits the parameter (or passes NULL explicitly, overriding the DEFAULT)
  -- can never silently skip either the 'IF p_manager_override' PIN-verify
  -- branch or the 'IF NOT p_manager_override' DISCOUNT_REQUIRES_MANAGER
  -- guard below -- NULL is neither TRUE nor FALSE in PL/pgSQL.
  p_manager_override := COALESCE(p_manager_override, false);

  PERFORM 1 FROM caja_sessions WHERE id = p_caja_session_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CAJA_CLOSED', 'message', 'Caja session is not open');
  END IF;
  PERFORM 1 FROM shifts WHERE id = p_shift_id AND staff_id = p_staff_id AND clock_out IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SHIFT_NOT_OPEN', 'message', 'Shift is not open or does not belong to this cashier');
  END IF;

  SELECT p.id, p.tab_id, p.payment_group_id, t.staff_id, t.shift_id, t.caja_session_id
  INTO v_existing_payment_id, v_existing_tab_id, v_existing_group_id, v_existing_staff_id, v_existing_shift_id, v_existing_caja_id
  FROM payments p JOIN tabs t ON t.id = p.tab_id
  WHERE p.idempotency_key IN (p_idempotency_key, p_idempotency_key || '-leg0')
  ORDER BY p.processed_at LIMIT 1;
  IF FOUND THEN
    IF v_existing_staff_id IS DISTINCT FROM p_staff_id
       OR v_existing_shift_id IS DISTINCT FROM p_shift_id
       OR v_existing_caja_id IS DISTINCT FROM p_caja_session_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_UNAUTHORIZED', 'message', 'Not authorized to replay this payment');
    END IF;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT array_agg(id ORDER BY split_index) INTO v_existing_payment_ids FROM payments WHERE payment_group_id = v_existing_group_id;
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'tabId', v_existing_tab_id, 'paymentGroupId', v_existing_group_id, 'paymentIds', to_jsonb(v_existing_payment_ids));
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'tabId', v_existing_tab_id, 'paymentId', v_existing_payment_id);
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ITEMS', 'message', 'At least one item is required');
  END IF;
  IF (p_method IN ('cash', 'card', 'bank_transfer')) = (p_legs IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_METHOD', 'message', 'Provide one payment method or split legs');
  END IF;

  -- Phase 27 (T-27-02), re-keyed in Plan 08 (G-27-13): whenever a manager
  -- override is claimed — for the ad-hoc discount OR the below-cost
  -- floor-guard bypass evaluated later in the per-item loop — independently
  -- re-derive the AUTHORIZING staff from the entered PIN itself
  -- (p_manager_pin), never from the caller's own p_staff_id. The client's
  -- ManagerPinDialog is UX-only; this is the actual authorization boundary
  -- (mirrors process_refund's two-layer pattern). One PIN entry authorizes
  -- the whole checkout attempt (must_have backstop truth).
  IF p_manager_override THEN
    SELECT p.id INTO v_manager_staff_id
    FROM profiles p JOIN role_permissions rp ON rp.role = p.role
    WHERE p.pin = p_manager_pin AND p.is_active = true AND rp.action = 'apply_custom_discount';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Not authorized to apply a manager override');
    END IF;
  END IF;

  IF p_discount_scope IS NOT NULL OR p_discount_type IS NOT NULL
     OR p_discount_value IS NOT NULL OR p_discount_amount IS NOT NULL THEN
    IF NOT p_manager_override THEN
      RETURN jsonb_build_object('ok', false, 'code', 'DISCOUNT_REQUIRES_MANAGER', 'message', 'Ad-hoc discount requires manager authorization');
    END IF;
    IF p_discount_scope IS DISTINCT FROM 'all' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DISCOUNT_SCOPE', 'message', 'discountScope must be all for a direct sale');
    END IF;
    -- WR-05 fix: the four discount params are a single all-or-nothing group
    -- (the client always sends them together, useCheckoutSale.ts:133-141).
    -- A malformed/partial set (e.g. discountScope set but discountValue
    -- NULL) must be rejected here — never allowed to NULL-propagate through
    -- v_adhoc_discount/v_subtotal/v_derived_total, where it would silently
    -- defeat the AMOUNT_MISMATCH guard (`IF NULL THEN` is false, not an
    -- error, in plpgsql).
    IF p_discount_type IS NULL OR p_discount_value IS NULL OR p_discount_amount IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DISCOUNT_PARAMS', 'message', 'discountScope, discountType, discountValue and discountAmount must all be supplied together');
    END IF;
  END IF;

  -- Expiry-proximity trigger config (PROMO-02/D-01..D-04) — reuses the same
  -- settings.near_expiry row the near-expiry alert badge already reads, with
  -- the same double-COALESCE fallback pattern v_tax_inclusive uses below (a
  -- missing settings row leaves both NULL after SELECT INTO).
  SELECT COALESCE((value->>'thresholdDays')::int, 14), COALESCE((value->>'discountPercent')::numeric, 15)
    INTO v_near_expiry_threshold, v_near_expiry_discount_pct FROM settings WHERE key = 'near_expiry';
  v_near_expiry_threshold := COALESCE(v_near_expiry_threshold, 14);
  v_near_expiry_discount_pct := COALESCE(v_near_expiry_discount_pct, 15);

  -- Phase 28 (D-06): store-local timezone for the recurrence AND-filter
  -- below, fetched once per checkout, same double-COALESCE fallback pattern
  -- as v_near_expiry_threshold above.
  SELECT COALESCE((value->>'timezone')::text, 'America/Mexico_City') INTO v_store_tz
  FROM settings WHERE key = 'general';
  v_store_tz := COALESCE(v_store_tz, 'America/Mexico_City');

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    -- Reset every per-item variable at the top of each iteration — plpgsql's
    -- SELECT INTO does NOT null out target variables when zero rows match,
    -- so without this a product/inventory/promotion row missing for THIS
    -- item would silently inherit the PREVIOUS item's values (cost_price,
    -- expiry_date, category_id, promo candidate) — a latent staleness bug
    -- this floor guard and promotion match cannot tolerate.
    v_catalog_price := NULL; v_sold_by_weight := NULL; v_category_id := NULL;
    v_cost_price := NULL; v_expiry_date := NULL;
    v_cand_id := NULL; v_cand_rate := NULL; v_cand_created_at := NULL; v_cand_amount := NULL;
    v_expiry_amount := NULL; v_promo_id := NULL; v_promo_rate := NULL; v_line_discount := 0;

    SELECT base_price, sold_by_weight, category_id INTO v_catalog_price, v_sold_by_weight, v_category_id
    FROM products WHERE id = (v_elem->>'product_id')::uuid AND is_active = true FOR UPDATE;
    IF v_catalog_price IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRICE_MISMATCH', 'message', 'Item price does not match catalog');
    END IF;
    SELECT cost_price, expiry_date INTO v_cost_price, v_expiry_date
    FROM inventory WHERE product_id = (v_elem->>'product_id')::uuid FOR UPDATE;
    v_weight_grams := NULLIF(v_elem->>'weight_grams', '')::integer;
    IF v_weight_grams IS NOT NULL AND (v_weight_grams <= 0 OR v_weight_grams > 50000) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'WEIGHT_OUT_OF_RANGE', 'message', 'Weight must be between 0 and 50kg');
    END IF;
    IF COALESCE(v_sold_by_weight, false) AND v_weight_grams IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'WEIGHT_OUT_OF_RANGE', 'message', 'Weight must be between 0 and 50kg');
    END IF;
    v_expected_price := CASE WHEN COALESCE(v_sold_by_weight, false)
      THEN ROUND(v_catalog_price * (v_weight_grams / 1000.0), 2) ELSE v_catalog_price END;
    IF abs((v_elem->>'unit_price')::numeric - v_expected_price) > 0.01 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRICE_MISMATCH', 'message', 'Item price does not match catalog');
    END IF;

    -- Best-price-wins candidate pool (PROMO-04/D-05, extended Phase 28
    -- D-01/D-02/D-04/D-05/D-06): every active promotion matching this line
    -- item via the junction table (zero target rows = store-wide) AND
    -- passing the recurrence AND-filter is an independent candidate, never
    -- merged/deduped (must_have truth). The single largest discount amount
    -- wins; on an exact tie the most recently created promotion wins (D-06).
    -- Fixed-type is capped at the line's expected price via LEAST;
    -- percent-type is inherently capped since discount_value <= 100 (schema
    -- CHECK).
    SELECT p.id, p.discount_value, p.created_at,
      (CASE WHEN p.discount_type = 'percent'
            THEN ROUND(v_expected_price * p.discount_value / 100.0, 2)
            ELSE LEAST(p.discount_value, v_expected_price)
       END) AS amount
    INTO v_cand_id, v_cand_rate, v_cand_created_at, v_cand_amount
    FROM promotions p
    WHERE p.active
      AND now() BETWEEN p.starts_at AND p.ends_at
      AND (
        NOT EXISTS (SELECT 1 FROM promotion_targets pt WHERE pt.promotion_id = p.id)
        OR EXISTS (
          SELECT 1 FROM promotion_targets pt
          WHERE pt.promotion_id = p.id
            AND (pt.product_id = (v_elem->>'product_id')::uuid OR pt.category_id = v_category_id)
        )
      )
      AND (p.days_of_week IS NULL OR EXTRACT(DOW FROM now() AT TIME ZONE v_store_tz)::int = ANY(p.days_of_week))
      AND (p.start_time IS NULL OR (now() AT TIME ZONE v_store_tz)::time BETWEEN p.start_time AND p.end_time)
    ORDER BY amount DESC, p.created_at DESC
    LIMIT 1;

    -- Expiry-proximity auto-discount candidate (PROMO-02) — inclusive cutoff,
    -- same <= comparison useNearExpiryAlerts already uses.
    IF v_expiry_date IS NOT NULL AND v_expiry_date <= (CURRENT_DATE + v_near_expiry_threshold) THEN
      v_expiry_amount := ROUND(v_expected_price * v_near_expiry_discount_pct / 100.0, 2);
    END IF;

    -- Winner selection: a real promotion wins exact ties against the expiry
    -- candidate (it has no created_at to compare, D-06).
    IF v_cand_amount IS NOT NULL AND (v_expiry_amount IS NULL OR v_cand_amount >= v_expiry_amount) THEN
      v_line_discount := v_cand_amount;
      v_promo_id := v_cand_id;
      v_promo_rate := v_cand_rate;
    ELSIF v_expiry_amount IS NOT NULL THEN
      v_line_discount := v_expiry_amount;
      v_promo_id := NULL;
      v_promo_rate := v_near_expiry_discount_pct;
    ELSE
      v_line_discount := 0;
      v_promo_id := NULL;
      v_promo_rate := NULL;
    END IF;

    -- Defensive cap regardless of which candidate won (promotions.discount_value
    -- is DB-CHECK-bounded, but settings.near_expiry.discountPercent is a bare
    -- jsonb value with no DB constraint) — a winning discount can never
    -- exceed the line's expected price, so v_line_price can never go
    -- negative before the floor guard below even runs.
    v_line_discount := LEAST(v_line_discount, v_expected_price);

    -- Below-cost floor guard (PROMO-07/D-07/D-08): floor is exactly cost (0%
    -- margin), compared pre-tax/pre-modifier; a product with no inventory
    -- row (cost_price NULL) never trips it. Block + require manager
    -- override — never silent-cap, never silent-drop.
    v_line_price := v_expected_price - v_line_discount;
    IF v_line_price < COALESCE(v_cost_price, 0) AND NOT p_manager_override THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BELOW_COST_REQUIRES_OVERRIDE', 'message', 'This combination of discounts would sell below cost');
    END IF;

    IF v_line_discount > 0 THEN
      PERFORM record_audit('promotion.apply', 'order_item', v_promo_id, NULL,
        jsonb_build_object('productId', v_elem->>'product_id', 'discountAmount', v_line_discount, 'discountRate', v_promo_rate),
        'rpc');
    END IF;

    v_modifier_ids := COALESCE((SELECT array_agg(value::uuid)
      FROM jsonb_array_elements_text(COALESCE(v_elem->'modifier_ids', '[]'::jsonb)) AS t(value)), ARRAY[]::uuid[]);
    IF array_length(v_modifier_ids, 1) > 0 THEN
      IF EXISTS (SELECT 1 FROM unnest(v_modifier_ids) AS mid WHERE NOT EXISTS (
        SELECT 1 FROM product_modifiers pm WHERE pm.product_id = (v_elem->>'product_id')::uuid AND pm.modifier_id = mid
      )) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MODIFIER_MISMATCH', 'message', 'Modifier does not belong to this item''s product');
      END IF;
      SELECT COALESCE(SUM(price_delta), 0) INTO v_modifier_delta FROM modifiers WHERE id = ANY(v_modifier_ids);
    ELSE
      v_modifier_delta := 0;
    END IF;

    v_line_qty := COALESCE((v_elem->>'quantity')::int, 1);
    v_subtotal := v_subtotal + (v_line_price + v_modifier_delta) * v_line_qty;
    v_derived_items := v_derived_items || jsonb_build_object(
      'product_id', v_elem->>'product_id', 'quantity', v_line_qty, 'unit_price', v_line_price,
      'modifier_ids', to_jsonb(v_modifier_ids), 'modifier_price_delta', v_modifier_delta,
      'notes', NULLIF(v_elem->>'notes', ''), 'weight_grams', v_weight_grams,
      'cost_price_snapshot', v_cost_price,
      'promotion_id', v_promo_id, 'discount_rate', v_promo_rate, 'discount_amount', v_line_discount
    );
  END LOOP;

  v_subtotal := ROUND(v_subtotal, 2);

  -- Ad-hoc whole-sale discount (PROMO-05/D-10) — mirrors
  -- src/shared/lib/domain-helpers.ts's calculateDiscountAmount exactly.
  -- Authorization (p_manager_override + role re-check) already validated
  -- above; discountScope is restricted to 'all'.
  IF p_discount_scope IS NOT NULL THEN
    v_adhoc_discount := ROUND(LEAST(
      CASE WHEN p_discount_type = 'percent' THEN v_subtotal * (p_discount_value / 100.0) ELSE p_discount_value END,
      v_subtotal), 2);
    v_subtotal := ROUND(v_subtotal - v_adhoc_discount, 2);
  ELSE
    v_adhoc_discount := NULL;
  END IF;

  SELECT COALESCE((value->>'taxRatePercent')::numeric, 16), COALESCE((value->>'taxInclusive')::boolean, true)
    INTO v_tax_rate, v_tax_inclusive FROM settings WHERE key = 'billing';
  -- No 'billing' row at all (zero rows, distinct from a row missing the
  -- taxInclusive key -- the inline COALESCE above only fires when a row is
  -- returned) leaves both v_tax_rate/v_tax_inclusive NULL after SELECT INTO.
  -- v_tax_rate already had this exact fallback; v_tax_inclusive needs the
  -- same one so a pre-existing/missing settings row never silently resolves
  -- to exclusive mode (D-01).
  v_tax_rate := COALESCE(v_tax_rate, 16);
  v_tax_inclusive := COALESCE(v_tax_inclusive, true);
  IF v_tax_inclusive THEN
    v_derived_total := v_subtotal;
    v_tax := ROUND(v_subtotal - ROUND(v_subtotal / (1 + v_tax_rate / 100.0), 2), 2);
  ELSE
    v_tax := ROUND(v_subtotal * (v_tax_rate / 100.0), 2);
    v_derived_total := ROUND(v_subtotal + v_tax, 2);
  END IF;
  IF p_legs IS NULL THEN
    IF p_amount IS NULL OR abs(p_amount - v_derived_total) > 0.01 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'AMOUNT_MISMATCH', 'message', 'Payment amount does not match the derived sale total');
    END IF;
  ELSE
    IF p_expected_total IS NULL OR abs(p_expected_total - v_derived_total) > 0.01 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'AMOUNT_MISMATCH', 'message', 'Expected total does not match the derived sale total');
    END IF;
  END IF;

  INSERT INTO tabs (customer_name, staff_id, shift_id, caja_session_id, status)
  VALUES (p_customer_name, p_staff_id, p_shift_id, p_caja_session_id, 'open') RETURNING id INTO v_tab_id;
  INSERT INTO orders (tab_id, staff_id, status, notes) VALUES (v_tab_id, p_staff_id, 'pending', NULL) RETURNING id INTO v_order_id;
  INSERT INTO order_items (order_id, product_id, quantity, unit_price, modifier_ids, modifier_price_delta, notes, weight_grams, cost_price_snapshot, promotion_id, discount_rate, discount_amount)
  SELECT v_order_id, (elem->>'product_id')::uuid, (elem->>'quantity')::int, (elem->>'unit_price')::numeric,
    COALESCE((SELECT array_agg(value::uuid) FROM jsonb_array_elements_text(COALESCE(elem->'modifier_ids', '[]'::jsonb)) AS t(value)), ARRAY[]::uuid[]),
    (elem->>'modifier_price_delta')::numeric, elem->>'notes', NULLIF((elem->>'weight_grams')::text, '')::integer,
    (elem->>'cost_price_snapshot')::numeric,
    NULLIF(elem->>'promotion_id', '')::uuid, (elem->>'discount_rate')::numeric, (elem->>'discount_amount')::numeric
  FROM jsonb_array_elements(v_derived_items) AS elem;

  IF p_legs IS NULL THEN
    -- WR-03 fix: authorize the one legitimate bank_transfer caller (this
    -- freshly-inserted tab, same transaction) via a transaction-local GUC —
    -- see the matching check in process_payment_atomic.
    IF p_method = 'bank_transfer' THEN
      PERFORM set_config('app.bank_transfer_checkout_context', 'true', true);
    END IF;
    -- Phase 27 Plan 09 (G-27-13): forward this call's OWN already-validated
    -- p_manager_override/p_manager_pin through — process_payment_atomic
    -- independently re-verifies a manager override too, and without
    -- forwarding these values the inner check would reject every
    -- ad-hoc-discounted direct sale a second time with default false/NULL.
    v_result := process_payment_atomic(p_tab_id := v_tab_id, p_staff_id := p_staff_id, p_amount := p_amount,
      p_method := p_method, p_idempotency_key := p_idempotency_key, p_tendered_amount := p_tendered_amount,
      p_reference_number := p_reference_number, p_discount_scope := p_discount_scope, p_discount_type := p_discount_type,
      p_discount_value := p_discount_value, p_discount_amount := v_adhoc_discount, p_customer_phone := p_customer_phone,
      p_manager_override := p_manager_override, p_manager_pin := p_manager_pin);
  ELSE
    -- Phase 27 Plan 09 (G-27-13): same forwarding rationale as the
    -- process_payment_atomic delegation above, for process_split_payment_atomic.
    v_result := process_split_payment_atomic(p_tab_id := v_tab_id, p_staff_id := p_staff_id, p_legs := p_legs,
      p_expected_total := p_expected_total, p_idempotency_key := p_idempotency_key, p_discount_scope := p_discount_scope,
      p_discount_type := p_discount_type, p_discount_value := p_discount_value, p_discount_amount := v_adhoc_discount,
      p_manager_override := p_manager_override, p_manager_pin := p_manager_pin);
  END IF;
  IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN RAISE EXCEPTION 'DIRECT_SALE_PAYMENT_FAILED: %', v_result->>'message'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tabs WHERE id = v_tab_id AND status = 'paid') THEN
    RAISE EXCEPTION 'DIRECT_SALE_PAYMENT_FAILED: %', 'Payment did not cover the sale total';
  END IF;
  RETURN jsonb_build_object('ok', true, 'tabId', v_tab_id, 'paymentId', v_result->>'paymentId',
    'paymentGroupId', v_result->>'paymentGroupId', 'paymentIds', v_result->'paymentIds',
    'idempotent', COALESCE((v_result->>'idempotent')::boolean, false));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'code', 'DIRECT_SALE_FAILED', 'message', SQLERRM);
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
