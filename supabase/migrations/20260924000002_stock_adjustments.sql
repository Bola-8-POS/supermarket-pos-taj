-- Stock adjustments: one RPC updates stock, writes the ledger row and the
-- audit row together.

CREATE OR REPLACE FUNCTION public.adjust_inventory(
  p_product_id uuid,
  p_quantity_delta integer,
  p_reason text,
  p_notes text DEFAULT NULL,
  p_expected_quantity integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_before record;
  v_after  record;
  v_movement_id uuid;
BEGIN
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles p
    JOIN role_permissions rp ON rp.role = p.role
    WHERE p.id = v_caller AND p.is_active = true AND rp.action = 'adjust_inventory'
  ) THEN
    RAISE EXCEPTION 'AUTH_FORBIDDEN: not allowed to adjust stock';
  END IF;
  IF p_quantity_delta IS NULL OR p_quantity_delta = 0 THEN
    RAISE EXCEPTION 'INVALID_DELTA: quantity delta must be non-zero';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'INVALID_REASON: a reason is required';
  END IF;

  SELECT * INTO v_before FROM inventory WHERE product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no stock row for product %', p_product_id;
  END IF;
  IF p_expected_quantity IS NOT NULL AND v_before.quantity_on_hand <> p_expected_quantity THEN
    RAISE EXCEPTION 'STOCK_CHANGED: expected % but stock is %', p_expected_quantity, v_before.quantity_on_hand;
  END IF;

  UPDATE inventory
     SET quantity_on_hand = quantity_on_hand + p_quantity_delta, updated_at = now()
   WHERE product_id = p_product_id
   RETURNING * INTO v_after;

  INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, notes)
  VALUES (p_product_id, p_quantity_delta, p_reason, v_caller, p_notes)
  RETURNING id INTO v_movement_id;

  PERFORM record_audit('inventory.adjust', 'inventory', v_before.id,
    to_jsonb(v_before), to_jsonb(v_after) || jsonb_build_object('reason', p_reason, 'movement_id', v_movement_id), 'rpc');

  RETURN jsonb_build_object('ok', true, 'quantityOnHand', v_after.quantity_on_hand, 'movementId', v_movement_id);
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_inventory(uuid, integer, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_inventory(uuid, integer, text, text, integer) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
