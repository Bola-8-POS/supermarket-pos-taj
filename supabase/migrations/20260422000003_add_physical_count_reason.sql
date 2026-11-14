-- Update inventory triggers to use standardised reason codes before adding constraint.
-- Previous trigger wrote 'Order item created: <uuid>' — normalise to 'sale' / 'correction'.
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
    'sale',
    o.staff_id
  FROM orders o
  WHERE o.id = NEW.order_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
    'correction',
    o.staff_id
  FROM orders o
  WHERE o.id = OLD.order_id;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Add check constraint on inventory_log.reason to enumerate valid values,
-- including the new 'physical_count' reason used during physical inventory counts.
-- NOT VALID skips scanning existing rows that predate this migration.
ALTER TABLE inventory_log
  ADD CONSTRAINT inventory_log_reason_check
  CHECK (reason IN ('sale', 'manual_adjustment', 'waste', 'delivery', 'correction', 'physical_count'))
  NOT VALID;
