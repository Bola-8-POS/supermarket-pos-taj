-- =====================================================
-- TRIGGERS
-- =====================================================

-- Function: Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to all tables
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_shifts_updated_at BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_modifiers_updated_at BEFORE UPDATE ON modifiers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tabs_updated_at BEFORE UPDATE ON tabs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_order_items_updated_at BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pool_tables_updated_at BEFORE UPDATE ON pool_tables
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pool_sessions_updated_at BEFORE UPDATE ON pool_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_inventory_updated_at BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function: Auto-decrement inventory on order item creation
CREATE OR REPLACE FUNCTION decrement_inventory_on_order_item()
RETURNS TRIGGER AS $$
BEGIN
  -- Decrement inventory quantity
  UPDATE inventory
  SET quantity_on_hand = quantity_on_hand - NEW.quantity
  WHERE product_id = NEW.product_id;

  -- Log the inventory change
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_decrement_inventory_on_order_item
  AFTER INSERT ON order_items
  FOR EACH ROW
  EXECUTE FUNCTION decrement_inventory_on_order_item();

-- Function: Restore inventory on order item deletion (voided orders)
CREATE OR REPLACE FUNCTION restore_inventory_on_order_item_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Increment inventory quantity back
  UPDATE inventory
  SET quantity_on_hand = quantity_on_hand + OLD.quantity
  WHERE product_id = OLD.product_id;

  -- Log the inventory restoration
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_restore_inventory_on_order_item_delete
  AFTER DELETE ON order_items
  FOR EACH ROW
  EXECUTE FUNCTION restore_inventory_on_order_item_delete();
