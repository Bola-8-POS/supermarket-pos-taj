-- Task 4 (combos-and-terminal-caja, spec A.4/A.6): combo pricing pass in
-- process_direct_sale_atomic. Body copied VERBATIM from
-- 20260913000000_caja_per_terminal.sql (signature unchanged, 20 params) plus:
--   1. the per-item best-price-wins candidate query is restricted to
--      `AND p.kind = 'discount'` — a combo-kind promotion must never win a
--      per-line slot; it is only ever applied by the combo pass below.
--   2. a combo-matching pass after the item loop, before v_subtotal is
--      rounded: greedily applies the best-net combo application each round
--      (max 50 rounds) against a temp table of expanded sale units, then
--      re-materializes v_derived_items/v_subtotal from the result.
-- The client's mirrored (not shared) reference implementation is
-- src/entities/promotion/model/combo-pricing.ts (`evaluateCombos`,
-- `priceApplication`) — this plpgsql version is the sole pricing authority
-- at checkout. In particular, the proportional allocation for
-- bundle_price/fixed combos ports that file's clamp/redistribute fix: the
-- naive "remainder on the last unit" allocation is not bounded by that
-- unit's own price, so every unit is clamped to its price and any overflow
-- is redistributed onto earlier units (ascending unit_no) with headroom —
-- always satisfiable because gross <= sum(price) by construction for both
-- bundle_price and fixed.
BEGIN;

CREATE OR REPLACE FUNCTION public.process_direct_sale_atomic(p_staff_id uuid, p_shift_id uuid, p_caja_session_id uuid, p_items jsonb, p_idempotency_key text, p_method text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_tendered_amount numeric DEFAULT NULL::numeric, p_reference_number text DEFAULT NULL::text, p_legs jsonb DEFAULT NULL::jsonb, p_expected_total numeric DEFAULT NULL::numeric, p_discount_scope text DEFAULT NULL::text, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT NULL::numeric, p_customer_name text DEFAULT 'Walk-in'::text, p_customer_phone text DEFAULT NULL::text, p_manager_override boolean DEFAULT false, p_manager_pin text DEFAULT NULL::text, p_terminal_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
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
  -- Phase 28 (D-06): store-local timezone for the recurrence AND-filter below.
  v_store_tz text;
  -- Caja-per-terminal: the open caja's own terminal_id, for the mismatch guard below.
  v_caja_terminal text;
  -- Task 4: combo pass (spec A.4/A.6).
  v_combo record; v_slot record; v_app_units int[]; v_gross numeric; v_net numeric;
  v_best_net numeric; v_best_combo_id uuid; v_best_units int[]; v_best_gross numeric;
  v_best_type text; v_best_value numeric; v_iter int := 0; v_sum numeric; v_alloc numeric;
  v_running numeric; v_idx int; v_n int;
  v_residual numeric; v_unit_price numeric; v_unit_discount numeric;
  v_before jsonb; v_grp record;
  -- Review fix (round 1, Critical): dedicated per-slot scratch array, kept
  -- strictly separate from v_best_units (the WINNING application's units,
  -- written only inside the `IF v_gross > 0 AND v_net > v_best_net` branch).
  -- v_best_units used to double as this scratch during every slot-fill of
  -- EVERY candidate combo, so after the FOR v_combo loop it held whichever
  -- candidate's last slot was evaluated last, not necessarily the winner's.
  v_slot_units int[];
  -- Review fix (round 1, Important #2): per-application counter so the
  -- below-cost floor guard can be checked once per whole combo application
  -- (Σrevenue vs Σcost across every unit it consumed), not per resulting row.
  v_app_no int := 0;
BEGIN
  -- Phase 27 gap-closure code review (CR-01/CR-02): coalesce a stray SQL NULL
  -- to false so a caller that omits the parameter (or passes NULL explicitly,
  -- overriding the DEFAULT) can never silently skip both the 'IF
  -- p_manager_override' PIN-verification branch AND the 'IF NOT
  -- p_manager_override' DISCOUNT_REQUIRES_MANAGER guard below -- NULL is
  -- neither TRUE nor FALSE in PL/pgSQL, so both branches would otherwise be
  -- skipped. Defense-in-depth: all three RPCs grant EXECUTE to 'authenticated',
  -- so a caller can invoke them directly via PostgREST, bypassing the edge
  -- function's own '?? false' coalesce entirely.
  p_manager_override := COALESCE(p_manager_override, false);

  SELECT terminal_id INTO v_caja_terminal FROM caja_sessions WHERE id = p_caja_session_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CAJA_CLOSED', 'message', 'Caja session is not open');
  END IF;
  IF p_terminal_id IS NOT NULL AND v_caja_terminal <> p_terminal_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CAJA_CLOSED', 'message', 'Caja session belongs to terminal ' || v_caja_terminal);
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
  -- Configurable payment methods: rappi/uber_eats join the single-method
  -- (non-split) path, exactly like cash/card/bank_transfer.
  IF (p_method IN ('cash', 'card', 'bank_transfer', 'rappi', 'uber_eats')) = (p_legs IS NOT NULL) THEN
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
    -- CHECK). Task 4: restricted to kind='discount' — a combo-kind
    -- promotion is never a per-line candidate, only applied by the combo
    -- pass below.
    SELECT p.id, p.discount_value, p.created_at,
      (CASE WHEN p.discount_type = 'percent'
            THEN ROUND(v_expected_price * p.discount_value / 100.0, 2)
            ELSE LEAST(p.discount_value, v_expected_price)
       END) AS amount
    INTO v_cand_id, v_cand_rate, v_cand_created_at, v_cand_amount
    FROM promotions p
    WHERE p.active
      AND p.kind = 'discount'
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

  -- ===== Combo pass (spec A.4/A.6) =====
  -- Expands every non-weight-sold, non-consumed unit of every line into one
  -- row of _sale_units (one unit = one physical item), matches each active
  -- combo-kind promotion's slot composition, and greedily applies the
  -- best-NET combo application each round (net = gross - already-applied
  -- per-line discounts, so a combo never "steals" savings the per-line pass
  -- already won) until none clears net > 0 or 50 rounds are hit — mirrors
  -- combo-pricing.ts's `evaluateCombos` exactly (same greedy loop, same
  -- gross formulas per discount_type, same tie-break rules).
  CREATE TEMP TABLE IF NOT EXISTS _sale_units (
    unit_no serial PRIMARY KEY, item_idx int NOT NULL, product_id uuid NOT NULL, category_id uuid NOT NULL,
    price numeric NOT NULL, line_discount numeric NOT NULL, eligible boolean NOT NULL,
    combo_promo_id uuid, combo_discount numeric, combo_rate numeric, consumed boolean NOT NULL DEFAULT false,
    app_no int
  ) ON COMMIT DROP;
  TRUNCATE _sale_units;
  INSERT INTO _sale_units (item_idx, product_id, category_id, price, line_discount, eligible)
  SELECT i.idx - 1, (i.elem->>'product_id')::uuid, p.category_id,
         (i.elem->>'unit_price')::numeric + (i.elem->>'discount_amount')::numeric + (i.elem->>'modifier_price_delta')::numeric,
         (i.elem->>'discount_amount')::numeric,
         p.combo_eligible AND NOT EXISTS (
           WITH RECURSIVE anc AS (
             SELECT c.id, c.parent_id, c.combo_eligible FROM categories c WHERE c.id = p.category_id
             UNION ALL SELECT c.id, c.parent_id, c.combo_eligible FROM categories c JOIN anc ON c.id = anc.parent_id)
           SELECT 1 FROM anc WHERE NOT anc.combo_eligible)
  FROM jsonb_array_elements(v_derived_items) WITH ORDINALITY AS i(elem, idx)
  JOIN products p ON p.id = (i.elem->>'product_id')::uuid
  CROSS JOIN generate_series(1, (i.elem->>'quantity')::int)
  WHERE NULLIF(i.elem->>'weight_grams', '') IS NULL AND NOT p.sold_by_weight;

  LOOP
    v_iter := v_iter + 1; EXIT WHEN v_iter > 50;
    v_best_net := 0; v_best_combo_id := NULL;
    FOR v_combo IN
      SELECT p.id, p.name, p.discount_type, p.discount_value
      FROM promotions p
      WHERE p.kind = 'combo' AND p.active AND now() BETWEEN p.starts_at AND p.ends_at
        AND (p.days_of_week IS NULL OR EXTRACT(DOW FROM now() AT TIME ZONE v_store_tz)::int = ANY(p.days_of_week))
        AND (p.start_time IS NULL OR (now() AT TIME ZONE v_store_tz)::time BETWEEN p.start_time AND p.end_time)
      ORDER BY p.created_at DESC
    LOOP
      v_app_units := ARRAY[]::int[]; v_sum := 0;
      FOR v_slot IN SELECT s.id, s.quantity FROM promotion_combo_slots s WHERE s.promotion_id = v_combo.id ORDER BY s.position LOOP
        -- Review fix (round 1, Critical): v_slot_units is a dedicated
        -- per-slot scratch array — NEVER v_best_units, which must hold only
        -- the winning application's units (written once, in the winner
        -- branch below). Aliasing the two meant this scratch write, which
        -- fires unconditionally for every slot of every candidate combo
        -- (not just the eventual winner), clobbered whatever the previous
        -- winner branch had stored, so the allocation step below could end
        -- up discounting a completely different combo's units.
        SELECT array_agg(unit_no ORDER BY price DESC, unit_no) INTO v_slot_units
        FROM (
          SELECT u.unit_no, u.price FROM _sale_units u
          WHERE NOT u.consumed AND u.eligible AND NOT (u.unit_no = ANY(v_app_units))
            AND EXISTS (
              WITH RECURSIVE anc AS (
                SELECT c.id, c.parent_id FROM categories c WHERE c.id = u.category_id
                UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN anc ON c.id = anc.parent_id)
              SELECT 1 FROM promotion_targets t WHERE t.slot_id = v_slot.id
                AND (t.product_id = u.product_id OR t.category_id IN (SELECT id FROM anc)))
          ORDER BY u.price DESC, u.unit_no LIMIT v_slot.quantity
        ) pick;
        IF v_slot_units IS NULL OR array_length(v_slot_units, 1) < v_slot.quantity THEN v_app_units := NULL; EXIT; END IF;
        v_app_units := v_app_units || v_slot_units;
      END LOOP;
      CONTINUE WHEN v_app_units IS NULL OR array_length(v_app_units, 1) IS NULL;

      SELECT SUM(price), SUM(line_discount) INTO v_sum, v_alloc FROM _sale_units WHERE unit_no = ANY(v_app_units);
      v_gross := CASE v_combo.discount_type
        WHEN 'bundle_price'  THEN GREATEST(0, ROUND(v_sum - v_combo.discount_value, 2))
        WHEN 'percent'       THEN (SELECT SUM(ROUND(price * v_combo.discount_value / 100.0, 2)) FROM _sale_units WHERE unit_no = ANY(v_app_units))
        WHEN 'fixed'         THEN LEAST(v_combo.discount_value, v_sum)
        WHEN 'cheapest_free' THEN (SELECT COALESCE(SUM(price),0) FROM (SELECT price FROM _sale_units WHERE unit_no = ANY(v_app_units) ORDER BY price ASC, unit_no LIMIT v_combo.discount_value::int) c)
        ELSE 0 END;
      v_net := v_gross - v_alloc;
      IF v_gross > 0 AND v_net > v_best_net THEN
        v_best_net := v_net; v_best_combo_id := v_combo.id; v_best_gross := v_gross;
        v_best_type := v_combo.discount_type; v_best_value := v_combo.discount_value;
        SELECT array_agg(unit_no ORDER BY unit_no) INTO v_best_units FROM _sale_units WHERE unit_no = ANY(v_app_units);
      END IF;
    END LOOP;
    EXIT WHEN v_best_combo_id IS NULL;
    v_app_no := v_app_no + 1;

    -- allocate v_best_gross over v_best_units (spec A.4 allocation rules)
    IF v_best_type = 'cheapest_free' THEN
      UPDATE _sale_units SET combo_discount = 0 WHERE unit_no = ANY(v_best_units);
      UPDATE _sale_units SET combo_discount = price WHERE unit_no IN (
        SELECT unit_no FROM _sale_units WHERE unit_no = ANY(v_best_units) ORDER BY price ASC, unit_no LIMIT v_best_value::int);
    ELSIF v_best_type = 'percent' THEN
      UPDATE _sale_units SET combo_discount = ROUND(price * v_best_value / 100.0, 2) WHERE unit_no = ANY(v_best_units);
    ELSE  -- bundle_price / fixed: proportional, remainder on the last unit, then clamp+redistribute
      SELECT SUM(price) INTO v_sum FROM _sale_units WHERE unit_no = ANY(v_best_units);
      v_running := 0; v_n := array_length(v_best_units, 1);
      FOR v_idx IN 1..v_n LOOP
        IF v_idx = v_n THEN v_alloc := ROUND(v_best_gross - v_running, 2);
        ELSE SELECT ROUND(v_best_gross * price / v_sum, 2) INTO v_alloc FROM _sale_units WHERE unit_no = v_best_units[v_idx]; END IF;
        UPDATE _sale_units SET combo_discount = v_alloc WHERE unit_no = v_best_units[v_idx];
        v_running := v_running + v_alloc;
      END LOOP;

      -- Required correction (ported from combo-pricing.ts's priceApplication
      -- clamp/redistribute pass, the same bug fixed client-side in Task 3):
      -- the naive proportional allocation above is not bounded by a unit's
      -- own price — the remainder always lands on the LAST unit in ascending
      -- unit_no order, which can be a cheap one. Clamp every unit to its own
      -- price, collect the overflow, and push it back onto earlier units'
      -- remaining headroom (ascending unit_no) until fully placed — always
      -- satisfiable because v_best_gross <= v_sum by construction for both
      -- bundle_price (GREATEST(0, sum - value)) and fixed (LEAST(value, sum)).
      v_residual := 0;
      FOR v_idx IN 1..v_n LOOP
        SELECT price, combo_discount INTO v_unit_price, v_unit_discount
        FROM _sale_units WHERE unit_no = v_best_units[v_idx];
        IF v_unit_discount > v_unit_price THEN
          v_residual := ROUND(v_residual + (v_unit_discount - v_unit_price), 2);
          UPDATE _sale_units SET combo_discount = v_unit_price WHERE unit_no = v_best_units[v_idx];
        END IF;
      END LOOP;
      IF v_residual > 0 THEN
        FOR v_idx IN 1..v_n LOOP
          EXIT WHEN v_residual <= 0;
          SELECT price - combo_discount INTO v_unit_price -- reused as headroom
          FROM _sale_units WHERE unit_no = v_best_units[v_idx];
          IF v_unit_price > 0 THEN
            v_unit_price := LEAST(v_unit_price, v_residual);
            UPDATE _sale_units SET combo_discount = combo_discount + v_unit_price WHERE unit_no = v_best_units[v_idx];
            v_residual := ROUND(v_residual - v_unit_price, 2);
          END IF;
        END LOOP;
      END IF;
    END IF;
    UPDATE _sale_units SET consumed = true, combo_promo_id = v_best_combo_id,
      combo_rate = CASE WHEN v_best_type = 'percent' THEN v_best_value ELSE NULL END,
      app_no = v_app_no
    WHERE unit_no = ANY(v_best_units);
  END LOOP;

  -- Re-materialise v_derived_items when at least one combo application
  -- consumed units: every group (item_idx, consumed, combo_promo_id,
  -- combo_discount) becomes one order_items row; unconsumed units copy the
  -- original element with only 'quantity' replaced. Weight-sold lines never
  -- entered _sale_units and are appended unchanged.
  IF EXISTS (SELECT 1 FROM _sale_units WHERE consumed) THEN
    v_before := v_derived_items; v_derived_items := '[]'::jsonb; v_subtotal := 0;

    -- Review fix (round 1, Important #1 — product decision): the below-cost
    -- floor guard for combo-consumed units is checked once per WHOLE
    -- application (Σrevenue vs Σcost across every unit that ONE combo
    -- application produced), not per resulting row. A per-row check (the
    -- prior version of this migration) trips on essentially every
    -- cheapest_free combo, since the freed unit's own row is priced 0 —
    -- below any positive cost — even though the other units in the same
    -- application cover the margin, which is the entire point of the
    -- mechanic. `revenue`/`cost` here mirror the exact per-row formula this
    -- replaces (unit_price + discount_amount - combo_discount vs
    -- cost_price_snapshot, modifier_price_delta excluded, same as the
    -- original per-line floor guard above), just summed per app_no instead
    -- of applied per row.
    FOR v_grp IN
      SELECT u.app_no,
        SUM((o.orig->>'unit_price')::numeric + (o.orig->>'discount_amount')::numeric - u.combo_discount) AS revenue,
        SUM(COALESCE((o.orig->>'cost_price_snapshot')::numeric, 0)) AS cost
      FROM _sale_units u
      JOIN LATERAL (
        SELECT elem FROM jsonb_array_elements(v_before) WITH ORDINALITY d(elem, i) WHERE d.i - 1 = u.item_idx
      ) o(orig) ON true
      WHERE u.consumed
      GROUP BY u.app_no
    LOOP
      IF v_grp.revenue < v_grp.cost AND NOT p_manager_override THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BELOW_COST_REQUIRES_OVERRIDE', 'message', 'This combination of discounts would sell below cost');
      END IF;
    END LOOP;

    FOR v_grp IN
      SELECT u.item_idx, u.consumed, u.combo_promo_id, u.combo_rate, u.combo_discount, COUNT(*)::int AS qty,
             (SELECT elem FROM jsonb_array_elements(v_before) WITH ORDINALITY d(elem, i) WHERE d.i - 1 = u.item_idx) AS orig
      FROM _sale_units u
      GROUP BY u.item_idx, u.consumed, u.combo_promo_id, u.combo_rate, u.combo_discount
      ORDER BY u.item_idx, u.consumed, u.combo_discount
    LOOP
      IF v_grp.consumed THEN
        -- unit_price = catalog price (orig unit_price + orig discount) - combo
        -- discount, modifier delta stays separate. The below-cost check
        -- already ran once per application above; GREATEST(0, ...) here is
        -- only a defensive backstop (never the below-cost decision itself)
        -- so a unit whose modifier delta interacts with the combo discount
        -- can never compute a small negative value that would otherwise trip
        -- order_items' raw CHECK constraint with an unformatted DB error.
        v_line_price := GREATEST(0, ROUND((v_grp.orig->>'unit_price')::numeric + (v_grp.orig->>'discount_amount')::numeric - v_grp.combo_discount, 2));
        v_derived_items := v_derived_items || (v_grp.orig || jsonb_build_object(
          'quantity', v_grp.qty, 'unit_price', v_line_price,
          'promotion_id', v_grp.combo_promo_id, 'discount_rate', v_grp.combo_rate, 'discount_amount', v_grp.combo_discount));
      ELSE
        v_derived_items := v_derived_items || (v_grp.orig || jsonb_build_object('quantity', v_grp.qty));
      END IF;
    END LOOP;
    -- weight lines never entered _sale_units: append them unchanged
    FOR v_elem IN SELECT elem FROM jsonb_array_elements(v_before) WITH ORDINALITY d(elem, i)
                  WHERE NOT EXISTS (SELECT 1 FROM _sale_units u WHERE u.item_idx = d.i - 1) LOOP
      v_derived_items := v_derived_items || v_elem;
    END LOOP;
    SELECT ROUND(SUM(((e->>'unit_price')::numeric + (e->>'modifier_price_delta')::numeric) * (e->>'quantity')::int), 2)
      INTO v_subtotal FROM jsonb_array_elements(v_derived_items) e;
    -- one audit row per combo application
    FOR v_grp IN SELECT combo_promo_id, SUM(combo_discount) AS total FROM _sale_units WHERE consumed GROUP BY combo_promo_id LOOP
      PERFORM record_audit('promotion.apply', 'order_item', v_grp.combo_promo_id, NULL,
        jsonb_build_object('kind', 'combo', 'discountAmount', v_grp.total), 'rpc');
    END LOOP;
  END IF;

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
    -- p_manager_override/p_manager_pin through — process_payment_atomic now
    -- independently re-verifies a manager override too (added above), and
    -- without forwarding these values the inner check would reject every
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

REVOKE ALL ON FUNCTION public.process_direct_sale_atomic(uuid, uuid, uuid, jsonb, text, text, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_direct_sale_atomic(uuid, uuid, uuid, jsonb, text, text, numeric, numeric, text, jsonb, numeric, text, text, numeric, numeric, text, text, boolean, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- DOWN (manual): re-create process_direct_sale_atomic from
-- 20260913000000_caja_per_terminal.sql (drops the combo pass and restores
-- the discount-candidate query to its pre-Task-4 form, i.e. remove
-- `AND p.kind = 'discount'`).
