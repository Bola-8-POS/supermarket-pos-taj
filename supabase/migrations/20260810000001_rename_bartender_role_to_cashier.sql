-- =============================================================================
-- Phase 1 (strip-rebrand) Plan 03 Task 2: [BLOCKING] rename user_role enum
-- value 'bartender' -> 'cashier' (D-16), and rewrite every live RLS policy /
-- function body that embeds the literal string.
--
-- Applied ONLY against the self-hosted supermarket-pos project
-- (supabase/config.toml project_id != shsrhxleopmovzpzqmex, the live bar's
-- production project) — see the project-id guard the caller runs before
-- `supabase db push`.
--
-- ALTER TYPE ... RENAME VALUE is atomic and automatically migrates every
-- existing profiles.role = 'bartender' row (and the profiles.role DEFAULT
-- expression) to 'cashier' along with it, since enum values are stored by
-- OID, not string — confirmed empirically against the live project before
-- authoring this migration. It does NOT rewrite embedded string literals
-- inside RLS policy USING/WITH CHECK clauses or PL/pgSQL function bodies
-- (get_user_role() = 'bartender' casts the literal at evaluation time and
-- would raise "invalid input value for enum" once the label no longer
-- exists) — RESEARCH.md's ASVS V4 threat (T-01-05, Elevation of Privilege).
--
-- Every remaining live object was found by querying pg_policies/pg_proc on
-- the LIVE project directly (not migration file history, which is mostly
-- superseded), confirming this is the complete set as of this migration:
--   SELECT schemaname, tablename, policyname FROM pg_policies
--     WHERE qual::text ILIKE '%bartender%' OR with_check::text ILIKE '%bartender%';
--   SELECT proname FROM pg_proc
--     WHERE prosrc ILIKE '%bartender%' AND pronamespace = 'public'::regnamespace;
-- -> 11 policies (10 SELECT/DELETE role-array checks + 1 UPDATE), 5 functions
-- (all 5 only reference 'bartender' in comments/error-message text, not in
-- an actual role-literal comparison — deplete_for_order_item, open_open_unit,
-- correct_open_unit, seat_waitlist_party_and_start_session, split_tab_by_person).
-- Also checked pg_attrdef (profiles.role DEFAULT, auto-migrated by the enum
-- rename — restated here only for documentation, not re-applied), pg_views,
-- and pg_constraint for the literal: none found beyond the above.
--
-- Policy identifiers containing "bartender" (rappi_orders_select_bartender,
-- rappi_orders_update_bartender, order_items_delete_bartender) are left as
-- historical names — only their USING/WITH CHECK literal content is rewritten
-- below, per this task's own action text (ALTER POLICY <name> ... USING (...)
-- WITH CHECK (...) with the literal replaced, not a policy rename).
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Rename the enum value. Auto-migrates every profiles.role = 'bartender'
--    row (and the profiles.role DEFAULT) to 'cashier'.
-- -----------------------------------------------------------------------------
ALTER TYPE user_role RENAME VALUE 'bartender' TO 'cashier';

-- -----------------------------------------------------------------------------
-- 2. Rewrite every live RLS policy embedding the literal (ALTER POLICY, never
--    DROP+CREATE, so nothing else about each policy's shape can drift).
-- -----------------------------------------------------------------------------
ALTER POLICY caja_entries_select_authenticated ON caja_entries
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

ALTER POLICY caja_sessions_select_authenticated ON caja_sessions
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

ALTER POLICY order_items_delete_bartender ON order_items
  USING (get_user_role() = 'cashier'::user_role);

ALTER POLICY prep_productions_select_authenticated ON prep_productions
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role, 'kitchen'::user_role]));

ALTER POLICY rappi_orders_select_bartender ON rappi_orders
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

ALTER POLICY rappi_orders_update_bartender ON rappi_orders
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]))
  WITH CHECK (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

ALTER POLICY refund_items_select_authenticated ON refund_items
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

ALTER POLICY refunds_select_authenticated ON refunds
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

ALTER POLICY resource_transfers_select_authenticated ON resource_transfers
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

ALTER POLICY tab_transfers_select_authenticated ON tab_transfers
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

ALTER POLICY waitlist_entries_select_authenticated ON waitlist_entries
  USING (get_user_role() = ANY (ARRAY['cashier'::user_role, 'manager'::user_role, 'admin'::user_role]));

-- -----------------------------------------------------------------------------
-- 3. Recreate the 5 function bodies whose source text (comments and/or
--    AUTH_FORBIDDEN error-message copy) mentions "bartender" — none of these
--    contain an actual 'bartender'::user_role comparison, so behavior is
--    unchanged; only prosrc text updates. Each is reproduced verbatim from
--    its live definition (pg_get_functiondef), text-substituted only.
-- -----------------------------------------------------------------------------

-- deplete_for_order_item (v5, from 20260729000004_deplete_for_order_item_v5_open_units.sql):
-- role-guard error message only.
CREATE OR REPLACE FUNCTION public.deplete_for_order_item(p_order_item_id uuid, p_direction smallint, p_allow_negative boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_product_id    uuid;
  v_qty           int;
  v_recipe_id     uuid;
  v_yield_qty     numeric;
  v_item          record;
  v_delta         numeric;
  v_reason        text;
  v_modifier_ids  uuid[];
  v_mod_item      record;
  v_mod_delta     numeric;
BEGIN
  -- Role guard: kitchen cannot call deplete_for_order_item directly
  IF get_user_role() IS NULL OR get_user_role() = 'kitchen' THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: cashier or higher required to call deplete_for_order_item';
  END IF;

  -- 1. Resolve order_item → product_id + quantity + modifier_ids
  SELECT product_id, quantity, modifier_ids
    INTO v_product_id, v_qty, v_modifier_ids
    FROM order_items
   WHERE id = p_order_item_id;

  IF NOT FOUND THEN RETURN; END IF;

  v_reason := CASE WHEN p_direction = 1 THEN 'sale' ELSE 'refund' END;

  -- 2. Find recipe for product; no recipe → skip the recipe loop only
  --    (D-04: modifier-driven depletion below must still run for
  --    recipe-less products, e.g. a bottled beer with an "extra lime"
  --    modifier).
  SELECT id, yield_qty
    INTO v_recipe_id, v_yield_qty
    FROM recipes
   WHERE product_id = v_product_id;

  IF FOUND THEN
    -- 3. Deplete each ingredient in the recipe
    FOR v_item IN
      SELECT ingredient_id, qty
        FROM recipe_items
       WHERE recipe_id = v_recipe_id
    LOOP
      -- delta = -(direction × order_qty × ingredient_qty / yield_qty)
      -- +1 direction (sale)   → negative delta (subtract from stock)
      -- -1 direction (refund) → positive delta (add back to stock)
      v_delta := -p_direction::numeric
                 * v_qty::numeric
                 * v_item.qty
                 / v_yield_qty;

      BEGIN
        PERFORM record_stock_movement(
          v_item.ingredient_id,
          v_delta,
          v_reason,         -- 'sale' or 'refund'
          'order_item',     -- ref_type
          p_order_item_id,  -- ref_id (idempotency key — UNIQUE with ingredient_id)
          NULL              -- notes
        );
      EXCEPTION WHEN OTHERS THEN
        -- Only bypass INVENTORY_NEGATIVE when override is explicitly allowed
        IF p_allow_negative AND SQLERRM LIKE '%INVENTORY_NEGATIVE%' THEN
          -- Bypass: directly update stock (record_stock_movement blocked it)
          UPDATE ingredients
             SET quantity_on_hand = quantity_on_hand + v_delta
           WHERE id = v_item.ingredient_id;

          -- Write audit trail (SECURITY DEFINER context — cannot be bypassed by client)
          INSERT INTO audit_log (action, entity_type, entity_id, details, created_at)
          VALUES (
            'stock_override',
            'order_item',
            p_order_item_id,
            jsonb_build_object(
              'ingredient_id', v_item.ingredient_id,
              'delta', v_delta,
              'reason', 'manager_override'
            ),
            now()
          );
        ELSE
          RAISE; -- Re-raise: INVENTORY_NEGATIVE without override, or any other error
        END IF;
      END;
    END LOOP;
  END IF;

  -- 4. Deplete each ingredient mapped to a modifier on this order_item
  --    (D-01: scales by quantity like the recipe loop; NO yield_qty divisor —
  --    delta is absolute-per-line, not per-yield-unit. Empty v_modifier_ids
  --    yields zero loop iterations — recipe-only orders are unaffected,
  --    preserving SC-4.)
  --    GROUP BY ingredient_id: two different modifiers on the same order item
  --    can both target the same ingredient (e.g. "Extra Lime" + "Heavy
  --    Garnish"). Without aggregating first, the second record_stock_movement
  --    call for that ingredient would collide with the
  --    (ref_type, ref_id, ingredient_id) partial unique index and abort the
  --    whole RPC (CR-01, Phase 17 code review — fixed here in v4).
  FOR v_mod_item IN
    SELECT ingredient_id, SUM(delta) AS delta
      FROM modifier_inventory_rules
     WHERE modifier_id = ANY(v_modifier_ids)
     GROUP BY ingredient_id
  LOOP
    v_mod_delta := -p_direction::numeric * v_qty::numeric * v_mod_item.delta;

    BEGIN
      PERFORM record_stock_movement(
        v_mod_item.ingredient_id,
        v_mod_delta,
        v_reason,                 -- 'sale' or 'refund' (shared with recipe loop)
        'order_item_modifier',    -- ref_type — distinct from recipe loop's 'order_item'
                                   -- so the (ref_type, ref_id, ingredient_id) partial
                                   -- unique index never collides even when the same
                                   -- ingredient appears in both loops.
        p_order_item_id,          -- ref_id (idempotency key — UNIQUE with ingredient_id)
        NULL                      -- notes
      );
    EXCEPTION WHEN OTHERS THEN
      -- D-05: identical override bypass as the recipe loop above
      IF p_allow_negative AND SQLERRM LIKE '%INVENTORY_NEGATIVE%' THEN
        UPDATE ingredients
           SET quantity_on_hand = quantity_on_hand + v_mod_delta
         WHERE id = v_mod_item.ingredient_id;

        INSERT INTO audit_log (action, entity_type, entity_id, details, created_at)
        VALUES (
          'stock_override',
          'order_item',
          p_order_item_id,
          jsonb_build_object(
            'ingredient_id', v_mod_item.ingredient_id,
            'delta', v_mod_delta,
            'reason', 'manager_override'
          ),
          now()
        );
      ELSE
        RAISE;
      END IF;
    END;
  END LOOP;

  -- 5. NEW (Phase 27, 27-02): open-unit branch. consume_open_unit no-ops for
  --    any product whose parent_product_id is NULL, so this is safe to add
  --    unconditionally — every existing product/test path is unaffected.
  IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id AND parent_product_id IS NOT NULL) THEN
    PERFORM consume_open_unit(v_product_id, v_qty, p_order_item_id, p_direction, p_allow_negative);
  END IF;
END;
$function$;

-- open_open_unit: role-guard error message + one comment.
CREATE OR REPLACE FUNCTION public.open_open_unit(p_product_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_per_package int;
  v_qty_on_hand int;
  v_unit_id     uuid;
  v_existing    record;
  v_after       jsonb;
BEGIN
  IF get_user_role() IS NULL OR get_user_role() = 'kitchen' THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: cashier or higher required to open a unit';
  END IF;

  SELECT units_per_package INTO v_per_package
  FROM   products
  WHERE  id = p_product_id;

  IF v_per_package IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: product % is not configured for open units', p_product_id;
  END IF;

  -- Lock the BOX product's inventory row before deciding whether a package
  -- is available. No bypass parameter exists here (see header note) — the
  -- manager-PIN-gated override lives on the order-entry path only.
  SELECT quantity_on_hand INTO v_qty_on_hand
  FROM   inventory
  WHERE  product_id = p_product_id
  FOR UPDATE;

  IF NOT FOUND OR v_qty_on_hand < 1 THEN
    RAISE EXCEPTION 'INVENTORY_NEGATIVE: no unopened package available for product %', p_product_id;
  END IF;

  -- Insert-then-catch (not look-then-insert): the partial unique index
  -- open_units_one_active_per_product decides, so two cashiers tapping
  -- simultaneously is race-proof by construction (D-07). The loser gets the
  -- friendly D-08 message with the live remaining count, not a silent
  -- auto-close of the existing unit.
  BEGIN
    INSERT INTO open_units (product_id, remaining_count, status, opened_by)
    VALUES (p_product_id, v_per_package, 'active', auth.uid())
    RETURNING id INTO v_unit_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM   open_units
    WHERE  product_id = p_product_id AND status = 'active';

    RAISE EXCEPTION 'DUPLICATE_ENTRY: an open unit already exists for this product (% remaining) — sell through it first', v_existing.remaining_count;
  END;

  -- Package decrement happens only after the insert succeeds — a rejected
  -- open must never consume a package (T-27-03).
  UPDATE inventory
  SET    quantity_on_hand = quantity_on_hand - 1,
         updated_at       = now()
  WHERE  product_id = p_product_id;

  SELECT to_jsonb(u) INTO v_after FROM open_units u WHERE u.id = v_unit_id;
  PERFORM record_audit('open_unit.open', 'open_unit', v_unit_id, NULL, v_after, 'rpc');

  RETURN v_unit_id;
END;
$function$;

-- correct_open_unit: one comment only, no behavior change.
CREATE OR REPLACE FUNCTION public.correct_open_unit(p_open_unit_id uuid, p_remaining_count integer, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unit        record;
  v_per_package int;
  v_before      jsonb;
  v_after       jsonb;
BEGIN
  -- The client-side ManagerPinDialog is UX; this guard is the actual
  -- control (T-27-09) — a cashier calling this RPC directly must be
  -- rejected here, independent of any UI.
  IF get_user_role() NOT IN ('manager', 'admin') THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: manager or admin role required';
  END IF;

  -- A correction with no reason is exactly the unaudited-shrinkage hole
  -- T-27-10 covers.
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: reason is required';
  END IF;

  SELECT * INTO v_unit
  FROM   open_units
  WHERE  id = p_open_unit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: open unit % does not exist', p_open_unit_id;
  END IF;

  -- Correcting a closed unit would silently reopen stock.
  IF v_unit.status <> 'active' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: open unit % is not active', p_open_unit_id;
  END IF;

  SELECT units_per_package INTO v_per_package
  FROM   products
  WHERE  id = v_unit.product_id;

  IF p_remaining_count < 0 OR p_remaining_count > v_per_package THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: remaining count % is out of range 0..%', p_remaining_count, v_per_package;
  END IF;

  v_before := to_jsonb(v_unit);

  UPDATE open_units
  SET    remaining_count = p_remaining_count,
         updated_at      = now(),
         -- Freeing the partial unique index when corrected down to zero lets
         -- a fresh unit be opened for this product.
         status          = CASE WHEN p_remaining_count = 0 THEN 'exhausted' ELSE status END,
         closed_at       = CASE WHEN p_remaining_count = 0 THEN now() ELSE closed_at END,
         closed_by       = CASE WHEN p_remaining_count = 0 THEN auth.uid() ELSE closed_by END,
         closed_reason   = CASE WHEN p_remaining_count = 0 THEN 'corrected_to_zero' ELSE closed_reason END
  WHERE  id = p_open_unit_id;

  SELECT to_jsonb(u) INTO v_after FROM open_units u WHERE u.id = p_open_unit_id;

  -- Both the old and new counts must be recoverable from the audit row,
  -- which is why the before/after sandwich is mandatory here rather than
  -- optional. The supplied reason is merged into the after payload so it is
  -- recoverable even when the correction doesn't zero the unit out (in
  -- which case closed_reason on the row itself stays null).
  PERFORM record_audit(
    'open_unit.correct',
    'open_unit',
    p_open_unit_id,
    v_before,
    v_after || jsonb_build_object('reason', p_reason),
    'rpc'
  );
END;
$function$;

-- seat_waitlist_party_and_start_session: one comment only, no behavior change.
CREATE OR REPLACE FUNCTION public.seat_waitlist_party_and_start_session(p_entry_id uuid, p_table_id uuid, p_staff_id uuid, p_shift_id uuid, p_caja_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry      waitlist_entries%ROWTYPE;
  v_table_type text;
  v_status     text;
  v_tab_id     uuid;
  v_start      jsonb;
BEGIN
  -- Re-assert the waitlist_entries_update_manager RLS policy this function
  -- bypasses by running as the table owner, as the first statement before
  -- any read or write. Without this a cashier could seat parties and open
  -- tabs, which that policy forbids today. This restores, not adds, an
  -- authorization rule -- manage_waitlist already covers this on the client.
  IF get_user_role() NOT IN ('manager', 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN');
  END IF;

  SELECT * INTO v_entry FROM waitlist_entries WHERE id = p_entry_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_entry.status = 'seated' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE_ENTRY');
  END IF;

  -- Lock the resource row here too, deliberately, before any write in this
  -- function. Taking this lock now means the later start_pool_session call
  -- cannot lose a race on this table -- the only remaining failure modes
  -- inside it are genuine exceptions, not a concurrent occupancy race.
  SELECT r.table_type, r.status::text INTO v_table_type, v_status
  FROM resources r
  WHERE r.id = p_table_id AND r.is_deleted = FALSE
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_status <> 'available' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'POOL_TABLE_OCCUPIED');
  END IF;

  UPDATE waitlist_entries
  SET status = 'seated', table_id = p_table_id, seated_at = now()
  WHERE id = p_entry_id;

  -- floating branch (D-05/D-06): zero automation, preserving today's
  -- fully-manual behavior for the Phase-26 floating-table path.
  IF v_table_type = 'floating' THEN
    RETURN jsonb_build_object('ok', true, 'tab_id', NULL, 'session', NULL);
  END IF;

  -- D-01 tab-naming convention: "{name} ({party_size})", e.g. "García (4)".
  -- table_number is NULL, matching StartSessionSheet's existing call; the
  -- customer_name_or_table CHECK is satisfied by customer_name.
  INSERT INTO tabs (customer_name, table_number, staff_id, shift_id, status, notes, caja_session_id)
  VALUES (v_entry.name || ' (' || v_entry.party_size::text || ')', NULL, p_staff_id, p_shift_id, 'open', NULL, p_caja_session_id)
  RETURNING id INTO v_tab_id;

  -- consumption branch (D-06): tab only, no pool_sessions row. Deliberately
  -- do NOT set resources.status = 'occupied' here -- nothing in this
  -- codebase ever clears that status without a pool session to stop
  -- (deactivate_floating_resource fires on session stop only), so writing
  -- it would strand consumption tables as permanently occupied. Leaving
  -- status untouched preserves exactly today's behavior.
  IF v_table_type = 'consumption' THEN
    RETURN jsonb_build_object('ok', true, 'tab_id', v_tab_id, 'session', NULL);
  END IF;

  -- pool/carom branch (D-06): identical treatment for both.
  v_start := start_pool_session(p_table_id, v_tab_id);

  -- This RAISE is the single most load-bearing line in this migration.
  -- start_pool_session signals failure by RETURNING ok:false, and a plain
  -- return from a called plpgsql function does not roll anything back --
  -- without this RAISE the tab insert and the waitlist status update above
  -- would commit while no session exists, which is precisely the
  -- non-atomic outcome D-02 rejected.
  IF NOT COALESCE((v_start->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'SEAT_START_SESSION_FAILED:%', COALESCE(v_start->>'code', 'UNKNOWN')
      USING errcode = 'P0S01';
  END IF;

  RETURN jsonb_build_object('ok', true, 'tab_id', v_tab_id, 'session', v_start->'session');

  -- Fallback for an unrecognised table_type (schema CHECK should prevent
  -- this from ever being reached, but every branch must return explicitly).
  RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR');
END;
$function$;

-- split_tab_by_person: one comment only, no behavior change.
CREATE OR REPLACE FUNCTION public.split_tab_by_person(p_parent_tab_id uuid, p_n integer, p_assignments jsonb)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent        record;
  v_assignment    jsonb;
  v_sub_tab_id    uuid;
  v_new_order_id  uuid;
  v_item_id       uuid;
  v_result_ids    uuid[] := '{}';
  v_assigned_ids  uuid[] := '{}';
  v_label         text;
BEGIN
  SELECT * INTO v_parent FROM tabs WHERE id = p_parent_tab_id FOR UPDATE;
  IF NOT FOUND OR v_parent.status != 'open' THEN
    RAISE EXCEPTION 'PARENT_TAB_PAID: tab % is not open', p_parent_tab_id;
  END IF;
  IF p_n < 2 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: n must be at least 2, got %', p_n;
  END IF;

  -- Validate no duplicate item assignments
  FOR v_assignment IN SELECT * FROM jsonb_array_elements(p_assignments) LOOP
    FOR v_item_id IN SELECT (elem)::uuid FROM jsonb_array_elements_text(v_assignment->'order_item_ids') AS elem LOOP
      IF v_item_id = ANY(v_assigned_ids) THEN
        RAISE EXCEPTION 'ITEM_ASSIGNED_TWICE: item % assigned to multiple persons', v_item_id;
      END IF;
      v_assigned_ids := v_assigned_ids || v_item_id;
    END LOOP;
  END LOOP;

  -- Pad assignments array to p_n entries if fewer are provided
  WHILE jsonb_array_length(p_assignments) < p_n LOOP
    p_assignments := p_assignments || jsonb_build_object(
      'sub_tab_label', 'Person ' || (jsonb_array_length(p_assignments) + 1),
      'order_item_ids', '[]'::jsonb
    );
  END LOOP;

  -- Create sub-tabs and reassign assigned items for each person
  FOR v_assignment IN SELECT * FROM jsonb_array_elements(p_assignments) LOOP
    v_label := v_assignment->>'sub_tab_label';

    INSERT INTO tabs (
      parent_tab_id, split_mode, split_label, status,
      staff_id, shift_id, customer_name
    )
    SELECT
      p_parent_tab_id,
      'by_person',
      v_label,
      'open',
      v_parent.staff_id,
      v_parent.shift_id,
      v_label
    RETURNING id INTO v_sub_tab_id;

    INSERT INTO orders (tab_id, staff_id, status)
    SELECT v_sub_tab_id, v_parent.staff_id, 'pending'
    RETURNING id INTO v_new_order_id;

    -- Reassign items explicitly assigned to this person
    FOR v_item_id IN SELECT (elem)::uuid FROM jsonb_array_elements_text(v_assignment->'order_item_ids') AS elem LOOP
      UPDATE order_items SET order_id = v_new_order_id WHERE id = v_item_id;
      -- Cascade combo children
      UPDATE order_items SET order_id = v_new_order_id WHERE parent_order_item_id = v_item_id;
    END LOOP;

    v_result_ids := v_result_ids || v_sub_tab_id;
  END LOOP;

  -- Unassigned items remain in the original parent orders (reference only)
  -- Their amounts are NOT included in sub-tab totals; they surface as "shared items"
  -- in the UI layer for the cashier to handle separately.

  -- Phase 15: trg_tabs_version rejects any UPDATE on `tabs` that doesn't
  -- advance version by exactly +1.
  UPDATE tabs
  SET status = 'split', split_mode = 'by_person', updated_at = now(), version = version + 1
  WHERE id = p_parent_tab_id;

  RETURN v_result_ids;
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TYPE user_role RENAME VALUE 'cashier' TO 'bartender';
-- -- Best-effort literal restoration only — any profiles row that was
-- -- created as 'cashier' (not merely renamed from a pre-existing
-- -- 'bartender' row) becomes 'bartender' too on rollback, since the enum
-- -- rename is OID-based and cannot distinguish the two; not recoverable.
-- ALTER POLICY caja_entries_select_authenticated ON caja_entries
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- ALTER POLICY caja_sessions_select_authenticated ON caja_sessions
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- ALTER POLICY order_items_delete_bartender ON order_items
--   USING (get_user_role() = 'bartender'::user_role);
-- ALTER POLICY prep_productions_select_authenticated ON prep_productions
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role, 'kitchen'::user_role]));
-- ALTER POLICY rappi_orders_select_bartender ON rappi_orders
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- ALTER POLICY rappi_orders_update_bartender ON rappi_orders
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]))
--   WITH CHECK (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- ALTER POLICY refund_items_select_authenticated ON refund_items
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- ALTER POLICY refunds_select_authenticated ON refunds
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- ALTER POLICY resource_transfers_select_authenticated ON resource_transfers
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- ALTER POLICY tab_transfers_select_authenticated ON tab_transfers
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- ALTER POLICY waitlist_entries_select_authenticated ON waitlist_entries
--   USING (get_user_role() = ANY (ARRAY['bartender'::user_role, 'manager'::user_role, 'admin'::user_role]));
-- -- Function bodies: re-run this migration's UP-block CREATE OR REPLACE
-- -- statements with every 'cashier' role-copy string reverted to 'bartender'
-- -- (comments/messages only — not provided verbatim here to avoid drift; see
-- -- git history of this file pre-rename for the exact prior bodies).
-- COMMIT;
-- =============================================================================
