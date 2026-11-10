-- Kitchen role removal (D29), step 3 of 4: functions.
-- Redefined whole from the live dev2 definitions (pg_get_functiondef; SECURITY DEFINER,
-- search_path public,pg_temp and grants unchanged). Deliberate changes only:
--  * deplete_for_order_item, open_open_unit: guard `= 'kitchen'` becomes the allow-list
--    `IS NULL OR NOT IN ('cashier','manager','admin')`.
--  * remove_tab_item: comment only (its check was already the allow-list).
CREATE OR REPLACE FUNCTION public.deplete_for_order_item(p_order_item_id uuid, p_direction smallint, p_allow_negative boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_product_id    uuid;
  v_qty           int;
BEGIN
  -- Role guard: only cashier, manager or admin may call deplete_for_order_item directly
  IF get_user_role() IS NULL OR get_user_role() NOT IN ('cashier', 'manager', 'admin') THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: cashier or higher required to call deplete_for_order_item';
  END IF;

  -- 1. Resolve order_item → product_id + quantity (unchanged from v5)
  SELECT product_id, quantity
    INTO v_product_id, v_qty
    FROM order_items
   WHERE id = p_order_item_id;

  IF NOT FOUND THEN RETURN; END IF;

  -- 2. Open-unit branch (unchanged from v5, Phase 27 27-02). consume_open_unit
  --    no-ops for any product whose parent_product_id is NULL, so this is
  --    safe to run unconditionally — every plain-product order item is
  --    unaffected.
  IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id AND parent_product_id IS NOT NULL) THEN
    PERFORM consume_open_unit(v_product_id, v_qty, p_order_item_id, p_direction, p_allow_negative);
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.open_open_unit(p_product_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_per_package int;
  v_qty_on_hand int;
  v_unit_id     uuid;
  v_existing    record;
  v_after       jsonb;
BEGIN
  IF get_user_role() IS NULL OR get_user_role() NOT IN ('cashier', 'manager', 'admin') THEN
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
$function$
;

CREATE OR REPLACE FUNCTION public.remove_tab_item(p_item_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order_id uuid;
  v_before jsonb;
  v_remaining int;
  v_tab_status tab_status;
BEGIN
  -- Only an active, staff member with a selling role may remove a line.
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('cashier', 'manager', 'admin')
  ) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: not allowed to remove lines';
  END IF;

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
$function$
;

NOTIFY pgrst, 'reload schema';
