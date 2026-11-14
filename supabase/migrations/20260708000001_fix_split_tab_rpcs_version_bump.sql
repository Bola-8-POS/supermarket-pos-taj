-- =============================================================================
-- fix(18): split-tab RPCs must bump tabs.version on their parent-tab UPDATE
--
-- Root cause: Phase 15 (20260512000001_versioned_rows.sql) added a universal
-- `trg_tabs_version` BEFORE UPDATE trigger on `tabs` that rejects ANY update
-- whose `version` does not advance by exactly +1 (raises STALE_VERSION,
-- SQLSTATE P0V01). The split-tab RPCs (split_tab_by_item, split_tab_by_person,
-- split_tab_by_amount — added earlier, in Phase 6) each finish with a plain
-- `UPDATE tabs SET status = 'split', ... WHERE id = p_parent_tab_id` that does
-- NOT bump `version`. Since that trigger fires on every row update, the final
-- UPDATE now unconditionally raises STALE_VERSION, which is an uncaught
-- exception inside the function's implicit transaction — so the ENTIRE RPC
-- call rolls back (sub-tab creation, order creation, order_item reassignment,
-- everything). The parent tab silently stays 'open' and no sub-tabs exist,
-- even though the client-side mutation hook reports whatever Postgres error
-- bubbles up.
--
-- Phase 15 already established the fix pattern for this exact class of bug in
-- 20260512000002_rpc_versioned_group_a.sql ("Group A" RPCs: process_payment_atomic,
-- create_order_with_items) — every UPDATE on `tabs` must include
-- `version = version + 1`. The split-tab RPCs were never migrated to this
-- pattern because they predate Phase 15 and were not in either Group A or
-- Group B's inventory. This migration brings them into compliance.
--
-- Fix: re-declare all three write RPCs (split_tab_by_item, split_tab_by_person,
-- split_tab_by_amount) with `version = version + 1` added to their closing
-- `UPDATE tabs SET status = 'split', ...` statement. Function bodies are
-- otherwise byte-for-byte identical to 20260427000002_split_tab_rpcs.sql.
-- split_tab_evenly is unaffected — it performs no writes to `tabs`.
--
-- Depends on:
--   - 20260427000002_split_tab_rpcs.sql (original RPC definitions)
--   - 20260512000001_versioned_rows.sql (version column + bump trigger)
-- =============================================================================

-- UP:
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. split_tab_by_item
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION split_tab_by_item(
  p_parent_tab_id uuid,
  p_assignments   jsonb   -- [{sub_tab_label: text, order_item_ids: [uuid, ...]}, ...]
) RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent        record;
  v_assignment    jsonb;
  v_sub_tab_id    uuid;
  v_new_order_id  uuid;
  v_item_id       uuid;
  v_result_ids    uuid[] := '{}';
  v_assigned_ids  uuid[] := '{}';
BEGIN
  -- Lock and validate parent tab
  SELECT * INTO v_parent FROM tabs WHERE id = p_parent_tab_id FOR UPDATE;
  IF NOT FOUND OR v_parent.status != 'open' THEN
    RAISE EXCEPTION 'PARENT_TAB_PAID: tab % is not open (status: %)', p_parent_tab_id, COALESCE(v_parent.status::text, 'not found');
  END IF;

  -- Validate: no item appears in more than one assignment + all items belong to parent
  FOR v_assignment IN SELECT * FROM jsonb_array_elements(p_assignments) LOOP
    FOR v_item_id IN SELECT (elem)::uuid FROM jsonb_array_elements_text(v_assignment->'order_item_ids') AS elem LOOP
      IF v_item_id = ANY(v_assigned_ids) THEN
        RAISE EXCEPTION 'ITEM_ASSIGNED_TWICE: item % appears in multiple assignments', v_item_id;
      END IF;
      -- Verify item belongs to parent tab (order_items → orders → tab_id)
      IF NOT EXISTS (
        SELECT 1 FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.id = v_item_id
          AND o.tab_id = p_parent_tab_id
          AND oi.parent_order_item_id IS NULL  -- only top-level items can be directly assigned
      ) THEN
        RAISE EXCEPTION 'ITEM_NOT_IN_PARENT: item % not found in tab %', v_item_id, p_parent_tab_id;
      END IF;
      v_assigned_ids := v_assigned_ids || v_item_id;
    END LOOP;
  END LOOP;

  -- Create sub-tabs and reassign items for each assignment
  FOR v_assignment IN SELECT * FROM jsonb_array_elements(p_assignments) LOOP
    -- Create sub-tab row (use split_label as customer_name to satisfy NOT NULL CHECK)
    INSERT INTO tabs (
      parent_tab_id, split_mode, split_label, status,
      staff_id, shift_id, customer_name
    )
    SELECT
      p_parent_tab_id,
      'item',
      v_assignment->>'sub_tab_label',
      'open',
      v_parent.staff_id,
      v_parent.shift_id,
      v_assignment->>'sub_tab_label'
    RETURNING id INTO v_sub_tab_id;

    -- Create order row for sub-tab (staff_id is NOT NULL on orders)
    INSERT INTO orders (tab_id, staff_id, status)
    SELECT v_sub_tab_id, v_parent.staff_id, 'pending'
    RETURNING id INTO v_new_order_id;

    -- Reassign each assigned order_item to the new order
    FOR v_item_id IN SELECT (elem)::uuid FROM jsonb_array_elements_text(v_assignment->'order_item_ids') AS elem LOOP
      UPDATE order_items SET order_id = v_new_order_id WHERE id = v_item_id;
      -- Cascade: combo children follow their parent item
      UPDATE order_items SET order_id = v_new_order_id WHERE parent_order_item_id = v_item_id;
    END LOOP;

    v_result_ids := v_result_ids || v_sub_tab_id;
  END LOOP;

  -- Mark parent as split. Phase 15: trg_tabs_version rejects any UPDATE on
  -- `tabs` that doesn't advance version by exactly +1.
  UPDATE tabs
  SET status = 'split', split_mode = 'item', updated_at = now(), version = version + 1
  WHERE id = p_parent_tab_id;

  RETURN v_result_ids;
END;
$$;

GRANT EXECUTE ON FUNCTION split_tab_by_item(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. split_tab_by_person
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION split_tab_by_person(
  p_parent_tab_id uuid,
  p_n             integer,
  p_assignments   jsonb   -- [{sub_tab_label: text, order_item_ids: [uuid, ...]}, ...]
) RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  -- in the UI layer for the bartender to handle separately.

  -- Phase 15: trg_tabs_version rejects any UPDATE on `tabs` that doesn't
  -- advance version by exactly +1.
  UPDATE tabs
  SET status = 'split', split_mode = 'by_person', updated_at = now(), version = version + 1
  WHERE id = p_parent_tab_id;

  RETURN v_result_ids;
END;
$$;

GRANT EXECUTE ON FUNCTION split_tab_by_person(uuid, integer, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. split_tab_by_amount
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION split_tab_by_amount(
  p_parent_tab_id uuid,
  p_amounts       jsonb   -- [{sub_tab_label: text, amount: numeric}, ...]
) RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent         record;
  v_total          numeric;
  v_amounts_sum    numeric;
  v_amount_row     jsonb;
  v_sub_tab_id     uuid;
  v_new_order_id   uuid;
  v_result_ids     uuid[] := '{}';
  v_label          text;
  -- Greedy allocation state
  v_item_row       record;
  v_buckets        numeric[];
  v_bucket_orders  uuid[];
  v_best_idx       integer;
  v_best_val       numeric;
  v_i              integer;
  v_n              integer;
BEGIN
  SELECT * INTO v_parent FROM tabs WHERE id = p_parent_tab_id FOR UPDATE;
  IF NOT FOUND OR v_parent.status != 'open' THEN
    RAISE EXCEPTION 'PARENT_TAB_PAID: tab % is not open', p_parent_tab_id;
  END IF;

  -- Compute parent total (top-level items only; combo children price at $0)
  SELECT COALESCE(SUM(oi.unit_price * oi.quantity), 0) INTO v_total
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.tab_id = p_parent_tab_id
    AND oi.parent_order_item_id IS NULL;

  -- Validate sum of amounts matches parent total (±0.01 tolerance)
  SELECT SUM((row_data->>'amount')::numeric) INTO v_amounts_sum
  FROM jsonb_array_elements(p_amounts) AS row_data;

  IF ABS(v_amounts_sum - v_total) > 0.01 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: amounts sum % does not match tab total % (±0.01 allowed)',
      v_amounts_sum, v_total;
  END IF;

  v_n := jsonb_array_length(p_amounts);
  v_buckets       := ARRAY[]::numeric[];
  v_bucket_orders := ARRAY[]::uuid[];

  -- Create sub-tabs and initialize allocation buckets
  v_i := 1;
  FOR v_amount_row IN SELECT * FROM jsonb_array_elements(p_amounts) LOOP
    v_label := v_amount_row->>'sub_tab_label';

    INSERT INTO tabs (
      parent_tab_id, split_mode, split_label, status,
      staff_id, shift_id, customer_name
    )
    SELECT
      p_parent_tab_id,
      'by_amount',
      v_label,
      'open',
      v_parent.staff_id,
      v_parent.shift_id,
      v_label
    RETURNING id INTO v_sub_tab_id;

    INSERT INTO orders (tab_id, staff_id, status)
    SELECT v_sub_tab_id, v_parent.staff_id, 'pending'
    RETURNING id INTO v_new_order_id;

    v_result_ids    := v_result_ids    || v_sub_tab_id;
    v_bucket_orders := v_bucket_orders || v_new_order_id;
    v_buckets       := v_buckets       || (v_amount_row->>'amount')::numeric;
    v_i := v_i + 1;
  END LOOP;

  -- Simple greedy allocation -- preserves item-level reporting at the cost of perfect proportionality.
  -- Items sorted descending by line-value; each assigned to the sub-tab with the largest remaining bucket.
  -- Remainder items (all buckets exhausted) fall to the last sub-tab (index v_n).
  FOR v_item_row IN
    SELECT oi.id AS item_id, (oi.unit_price * oi.quantity) AS line_value
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.tab_id = p_parent_tab_id
      AND oi.parent_order_item_id IS NULL
    ORDER BY (oi.unit_price * oi.quantity) DESC
  LOOP
    -- Find sub-tab with largest remaining bucket
    v_best_idx := 1;
    v_best_val := v_buckets[1];
    FOR v_i IN 2..v_n LOOP
      IF v_buckets[v_i] > v_best_val THEN
        v_best_val := v_buckets[v_i];
        v_best_idx := v_i;
      END IF;
    END LOOP;

    -- Assign item (and its combo children) to the winning sub-tab's order
    UPDATE order_items SET order_id = v_bucket_orders[v_best_idx] WHERE id = v_item_row.item_id;
    UPDATE order_items SET order_id = v_bucket_orders[v_best_idx] WHERE parent_order_item_id = v_item_row.item_id;

    -- Deduct item line-value from that bucket (allow negative — last sub-tab absorbs overflow)
    v_buckets[v_best_idx] := v_buckets[v_best_idx] - v_item_row.line_value;
  END LOOP;

  -- Phase 15: trg_tabs_version rejects any UPDATE on `tabs` that doesn't
  -- advance version by exactly +1.
  UPDATE tabs
  SET status = 'split', split_mode = 'by_amount', updated_at = now(), version = version + 1
  WHERE id = p_parent_tab_id;

  RETURN v_result_ids;
END;
$$;

GRANT EXECUTE ON FUNCTION split_tab_by_amount(uuid, jsonb) TO authenticated;

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- Restoring the prior (broken, pre-Phase-15-compliant) function bodies means
-- re-applying 20260427000002_split_tab_rpcs.sql, which will reintroduce the
-- STALE_VERSION bug against the trg_tabs_version trigger added in
-- 20260512000001_versioned_rows.sql. Not recommended. If a rollback is truly
-- required, re-run the CREATE OR REPLACE FUNCTION bodies from
-- 20260427000002_split_tab_rpcs.sql for split_tab_by_item, split_tab_by_person,
-- and split_tab_by_amount.
-- COMMIT;
-- =============================================================================
