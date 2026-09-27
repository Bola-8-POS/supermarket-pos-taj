-- `deplete_for_order_item` now only owns open-unit lifecycle. Refunds still need
-- to restore ordinary packaged-product inventory and write an auditable ledger row.
CREATE OR REPLACE FUNCTION public.restore_inventory_on_refund_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
  v_staff_id uuid;
BEGIN
  IF NOT NEW.restock THEN
    RETURN NEW;
  END IF;

  SELECT oi.product_id, r.created_by
    INTO v_product_id, v_staff_id
    FROM order_items oi
    JOIN refunds r ON r.id = NEW.refund_id
   WHERE oi.id = NEW.order_item_id;

  IF EXISTS (SELECT 1 FROM products WHERE id = v_product_id AND parent_product_id IS NULL) THEN
    UPDATE inventory
       SET quantity_on_hand = quantity_on_hand + NEW.qty,
           updated_at = now()
     WHERE product_id = v_product_id;
    INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id, ref_type, ref_id)
    VALUES (v_product_id, NEW.qty, 'refund', v_staff_id, 'refund', NEW.refund_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS restore_inventory_on_refund_item ON public.refund_items;
CREATE TRIGGER restore_inventory_on_refund_item
AFTER INSERT ON public.refund_items
FOR EACH ROW EXECUTE FUNCTION public.restore_inventory_on_refund_item();
