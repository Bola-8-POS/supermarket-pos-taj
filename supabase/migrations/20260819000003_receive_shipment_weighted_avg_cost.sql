-- Closes DATA-01: weighted-average cost_price + earliest-expiry-wins merge
-- (per CONTEXT.md D-01/D-02/D-03), replacing the last-write-wins overwrite
-- that silently destroyed a prior batch's cost/expiry data on restock.

CREATE OR REPLACE FUNCTION receive_shipment(p_staff_id uuid, p_supplier_id uuid, p_items jsonb)
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

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_elem->>'product_id')::uuid;
    v_quantity := (v_elem->>'quantity')::integer;
    v_cost_price := (v_elem->>'cost_price')::numeric(10,2);
    IF v_quantity IS NULL OR v_quantity <= 0 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_QUANTITY'; END IF;
    IF v_cost_price IS NULL OR v_cost_price < 0 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_COST'; END IF;
    PERFORM 1 FROM products WHERE id = v_product_id AND is_active = true FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PRODUCT_NOT_FOUND'; END IF;
  END LOOP;

  INSERT INTO shipments (supplier_id, received_by) VALUES (p_supplier_id, p_staff_id) RETURNING id INTO v_shipment_id;
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
  PERFORM record_audit('shipment.receive', 'shipment', v_shipment_id, NULL,
    jsonb_build_object('supplierId', p_supplier_id, 'itemCount', jsonb_array_length(p_items)));
  RETURN jsonb_build_object('ok', true, 'shipmentId', v_shipment_id);
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  RETURN jsonb_build_object('ok', false, 'code', SQLERRM, 'message', SQLERRM);
WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'code', 'RECEIVE_SHIPMENT_FAILED', 'message', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_shipment(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receive_shipment(uuid, uuid, jsonb) TO service_role;
