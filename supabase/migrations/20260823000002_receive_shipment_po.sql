-- Extend receive_shipment with an optional p_po_id (Phase 16, Plan 01 — PO-03,
-- D-04): receiving a PO in full still goes through this same RPC, which now
-- also atomically closes the referenced purchase_orders row in the same
-- transaction as the stock mutation. Per D-04 this is a promote, not an
-- add-alongside — no separate receive_po_shipment wrapper.
--
-- Adding a 4th parameter changes the function's argument-type signature from
-- (uuid, uuid, jsonb) to (uuid, uuid, jsonb, uuid). CREATE OR REPLACE does
-- NOT replace a function whose argument-type list differs — it creates a
-- second overload, and a 3-named-arg call would then be ambiguous between
-- the untouched 3-arg function and the new 4-arg-with-default one ("function
-- is not unique" error), silently breaking the existing ad-hoc Suppliers-page
-- receiving flow. Explicitly drop the old signature first.
DROP FUNCTION IF EXISTS receive_shipment(uuid, uuid, jsonb);

CREATE OR REPLACE FUNCTION receive_shipment(p_staff_id uuid, p_supplier_id uuid, p_items jsonb, p_po_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shipment_id uuid;
  v_elem jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_cost_price numeric(10,2);
  v_expiry_date date;
  v_old_qty integer;
  v_old_cost numeric(10,2);
  v_old_expiry date;
  v_new_cost numeric(10,2);
  v_new_expiry date;
  v_po_status text;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ITEMS', 'message', 'At least one line item is required');
  END IF;
  PERFORM 1 FROM profiles p JOIN role_permissions rp ON rp.role = p.role
    WHERE p.id = p_staff_id AND rp.action = 'adjust_inventory';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'Not authorized to receive shipments');
  END IF;
  PERFORM 1 FROM suppliers WHERE id = p_supplier_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUPPLIER_NOT_FOUND', 'message', 'Supplier not found');
  END IF;

  -- PO guard block (T-16-02/T-16-03): a nonexistent p_po_id and a p_po_id
  -- belonging to a different supplier both return the same
  -- PO_SUPPLIER_MISMATCH code from this single combined query — the
  -- Security Domain only calls for one mismatch-class guard, not a separate
  -- not-found code. Checked before any inventory/shipments mutation runs.
  -- FOR UPDATE locks the PO row for the rest of this transaction: a second
  -- concurrent receive_shipment() call for the same p_po_id blocks here
  -- until the first commits, then re-reads status='received' and is
  -- rejected — closing the race a plain SELECT/PERFORM would leave open
  -- between the guard check and the status UPDATE below.
  IF p_po_id IS NOT NULL THEN
    SELECT status INTO v_po_status FROM purchase_orders
      WHERE id = p_po_id AND supplier_id = p_supplier_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PO_SUPPLIER_MISMATCH', 'message', 'Purchase order not found for this supplier');
    END IF;
    IF v_po_status = 'received' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PO_ALREADY_RECEIVED', 'message', 'Purchase order already received');
    END IF;
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_elem->>'product_id')::uuid;
    v_quantity := (v_elem->>'quantity')::integer;
    v_cost_price := (v_elem->>'cost_price')::numeric(10,2);
    IF v_quantity IS NULL OR v_quantity <= 0 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_QUANTITY'; END IF;
    IF v_cost_price IS NULL OR v_cost_price < 0 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_COST'; END IF;
    PERFORM 1 FROM products WHERE id = v_product_id AND is_active = true FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PRODUCT_NOT_FOUND'; END IF;
  END LOOP;

  INSERT INTO shipments (supplier_id, received_by, po_id) VALUES (p_supplier_id, p_staff_id, p_po_id) RETURNING id INTO v_shipment_id;
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_elem->>'product_id')::uuid;
    v_quantity := (v_elem->>'quantity')::integer;
    v_cost_price := (v_elem->>'cost_price')::numeric(10,2);
    v_expiry_date := NULLIF(v_elem->>'expiry_date', '')::date;

    -- Lock and read the existing row first (EXCLUDED only exposes new
    -- values, can't reference old row inside ON CONFLICT DO UPDATE's SET
    -- expressions for a conditional branch).
    SELECT quantity_on_hand, cost_price, expiry_date
      INTO v_old_qty, v_old_cost, v_old_expiry
      FROM inventory WHERE product_id = v_product_id FOR UPDATE;

    IF NOT FOUND OR v_old_qty = 0 THEN
      -- D-02: zero-stock (or no row yet) — replace outright, no averaging.
      -- A zero-stock row can still carry a stale expiry_date from the
      -- sold-out batch; LEAST-ing against it would wrongly apply an
      -- irrelevant expired-batch date to fresh stock.
      v_new_cost := v_cost_price;
      v_new_expiry := v_expiry_date;
    ELSE
      -- D-01: weighted-average cost, rounded to numeric(10,2).
      v_new_cost := ROUND(
        (v_old_qty * v_old_cost + v_quantity * v_cost_price) / (v_old_qty + v_quantity),
        2
      );
      -- D-03: real date always wins over NULL; LEAST only when both sides
      -- are real dates; NULL only when both sides are NULL.
      v_new_expiry := LEAST(
        COALESCE(v_old_expiry, v_expiry_date),
        COALESCE(v_expiry_date, v_old_expiry)
      );
    END IF;

    INSERT INTO inventory (product_id, quantity_on_hand, cost_price, expiry_date)
      VALUES (v_product_id, v_quantity, v_new_cost, v_new_expiry)
      ON CONFLICT (product_id) DO UPDATE SET
        quantity_on_hand = inventory.quantity_on_hand + EXCLUDED.quantity_on_hand,
        cost_price = v_new_cost,
        expiry_date = v_new_expiry;
    INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
      VALUES (v_product_id, v_quantity, 'delivery', p_staff_id, 'shipment', v_shipment_id);
  END LOOP;

  -- D-04: close the PO atomically in the same transaction as the stock
  -- mutation, never a separate client-side update after the RPC call.
  IF p_po_id IS NOT NULL THEN
    UPDATE purchase_orders SET status = 'received', received_at = now() WHERE id = p_po_id;
  END IF;

  PERFORM record_audit('shipment.receive', 'shipment', v_shipment_id, NULL,
    jsonb_build_object('supplierId', p_supplier_id, 'itemCount', jsonb_array_length(p_items), 'poId', p_po_id));
  RETURN jsonb_build_object('ok', true, 'shipmentId', v_shipment_id);
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  RETURN jsonb_build_object('ok', false, 'code', SQLERRM, 'message', SQLERRM);
WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'code', 'RECEIVE_SHIPMENT_FAILED', 'message', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_shipment(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receive_shipment(uuid, uuid, jsonb, uuid) TO service_role;

-- DOWN: drop the 4-arg receive_shipment; recreate the 3-arg signature from
-- 20260819000003_receive_shipment_weighted_avg_cost.sql; drop the fresh
-- grants above and re-grant the 3-arg signature.
