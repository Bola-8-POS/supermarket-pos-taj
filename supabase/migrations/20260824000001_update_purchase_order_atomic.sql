-- Fix Phase 16 code review finding (16-REVIEW.md Critical #3): the client
-- previously ran UPDATE purchase_orders -> DELETE items -> INSERT items as
-- three separate round-trips. If the DELETE succeeded but the INSERT
-- failed, a PO's line items were permanently lost with no rollback.
--
-- SECURITY INVOKER (the default) is deliberate, not an oversight: it keeps
-- the existing purchase_orders_manage / purchase_order_items_manage RLS
-- policies as the sole authorization check, exactly as the three separate
-- statements it replaces were already gated. A plpgsql function body is
-- one implicit transaction — any exception rolls back every statement
-- inside it, which is the atomicity this migration adds.
CREATE FUNCTION update_purchase_order_atomic(p_id uuid, p_supplier_id uuid, p_items jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE purchase_orders SET supplier_id = p_supplier_id WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PO_NOT_FOUND';
  END IF;

  DELETE FROM purchase_order_items WHERE purchase_order_id = p_id;

  INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, cost_price)
  SELECT p_id, (elem->>'productId')::uuid, (elem->>'quantity')::integer, (elem->>'costPrice')::numeric(10,2)
  FROM jsonb_array_elements(p_items) AS elem;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_purchase_order_atomic(uuid, uuid, jsonb) TO authenticated;

-- DOWN: DROP FUNCTION update_purchase_order_atomic(uuid, uuid, jsonb);
