-- Inventory auto-decrement/restore triggers must run with elevated permissions
-- because bartenders insert order_items but cannot insert into inventory_log.
-- Without SECURITY DEFINER these triggers fail with RLS violations on
-- inventory_log, breaking order creation for bartenders.

CREATE OR REPLACE FUNCTION decrement_inventory_on_order_item()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE inventory
  SET quantity_on_hand = quantity_on_hand - NEW.quantity
  WHERE product_id = NEW.product_id;

  INSERT INTO inventory_log (product_id, quantity_delta, reason, staff_id)
  SELECT
    NEW.product_id,
    -NEW.quantity,
    'Order item created: ' || NEW.id::TEXT,
    o.staff_id
  FROM orders o
  WHERE o.id = NEW.order_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION restore_inventory_on_order_item_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE inventory
  SET quantity_on_hand = quantity_on_hand + OLD.quantity
  WHERE product_id = OLD.product_id;

  INSERT INTO inventory_log (product_id, quantity_delta, reason, staff_id)
  SELECT
    OLD.product_id,
    OLD.quantity,
    'Order item voided: ' || OLD.id::TEXT,
    o.staff_id
  FROM orders o
  WHERE o.id = OLD.order_id;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
