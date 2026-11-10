-- =============================================================================
-- S1-01: Rename inventory_log → stock_movements
-- Extended reason enum + polymorphic ref columns + updated triggers + RLS
-- =============================================================================

BEGIN;

-- 1. Rename the table
ALTER TABLE inventory_log RENAME TO stock_movements;

-- 2. Rename indexes
ALTER INDEX IF EXISTS idx_inventory_log_product_id RENAME TO idx_stock_movements_product_id;
ALTER INDEX IF EXISTS idx_inventory_log_staff_id   RENAME TO idx_stock_movements_staff_id;
ALTER INDEX IF EXISTS idx_inventory_log_created_at RENAME TO idx_stock_movements_created_at;

-- 3. Drop the old CHECK constraint (name is tied to the old table name, values too narrow)
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS inventory_log_reason_check;

-- 4. Add polymorphic reference columns + nullable ingredient FK (FK added in Phase 3)
ALTER TABLE stock_movements
  ADD COLUMN ref_type      text,
  ADD COLUMN ref_id        uuid,
  ADD COLUMN ingredient_id uuid NULL;

-- 5. Re-add CHECK with extended reason enum (NOT VALID skips scanning historical rows)
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_reason_check
  CHECK (reason IN (
    'sale',
    'manual_adjustment',
    'waste',
    'delivery',
    'correction',
    'physical_count',
    'prep_production',
    'prep_consumption',
    'combo_component',
    'refund',
    'void'
  )) NOT VALID;

-- 6. Rewrite trigger functions to INSERT into stock_movements (SECURITY DEFINER so
--    bartender-initiated order_item inserts/deletes still succeed under RLS).
CREATE OR REPLACE FUNCTION decrement_inventory_on_order_item()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE inventory
  SET quantity_on_hand = quantity_on_hand - NEW.quantity
  WHERE product_id = NEW.product_id;

  INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id)
  SELECT
    NEW.product_id,
    -NEW.quantity,
    'sale',
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

  INSERT INTO stock_movements (product_id, quantity_delta, reason, staff_id)
  SELECT
    OLD.product_id,
    OLD.quantity,
    'correction',
    o.staff_id
  FROM orders o
  WHERE o.id = OLD.order_id;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 7. Rename RLS policies (table rename preserves the enable-RLS state but policy names
--    reference old names — drop and recreate with new names).
DROP POLICY IF EXISTS "inventory_log_select_manager_admin" ON stock_movements;
DROP POLICY IF EXISTS "inventory_log_insert_manager_admin" ON stock_movements;
DROP POLICY IF EXISTS "inventory_log_delete_admin"         ON stock_movements;

-- Managers and admins can SELECT all stock movements
CREATE POLICY "stock_movements_select_manager_admin" ON stock_movements
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Managers and admins can INSERT stock movements
CREATE POLICY "stock_movements_insert_manager_admin" ON stock_movements
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Only admins can DELETE (append-only ledger — kept for break-glass admin correction)
CREATE POLICY "stock_movements_delete_admin" ON stock_movements
  FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP POLICY IF EXISTS "stock_movements_select_manager_admin" ON stock_movements;
-- DROP POLICY IF EXISTS "stock_movements_insert_manager_admin" ON stock_movements;
-- DROP POLICY IF EXISTS "stock_movements_delete_admin"         ON stock_movements;
-- CREATE POLICY "inventory_log_select_manager_admin" ON stock_movements
--   FOR SELECT TO authenticated USING (get_user_role() IN ('manager', 'admin'));
-- CREATE POLICY "inventory_log_insert_manager_admin" ON stock_movements
--   FOR INSERT TO authenticated WITH CHECK (get_user_role() IN ('manager', 'admin'));
-- CREATE POLICY "inventory_log_delete_admin" ON stock_movements
--   FOR DELETE TO authenticated USING (get_user_role() = 'admin');
-- ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reason_check;
-- ALTER TABLE stock_movements DROP COLUMN IF EXISTS ingredient_id;
-- ALTER TABLE stock_movements DROP COLUMN IF EXISTS ref_id;
-- ALTER TABLE stock_movements DROP COLUMN IF EXISTS ref_type;
-- ALTER TABLE stock_movements
--   ADD CONSTRAINT inventory_log_reason_check
--   CHECK (reason IN (
--     'sale','manual_adjustment','waste','delivery','correction','physical_count'
--   )) NOT VALID;
-- ALTER INDEX IF EXISTS idx_stock_movements_product_id RENAME TO idx_inventory_log_product_id;
-- ALTER INDEX IF EXISTS idx_stock_movements_staff_id   RENAME TO idx_inventory_log_staff_id;
-- ALTER INDEX IF EXISTS idx_stock_movements_created_at RENAME TO idx_inventory_log_created_at;
-- ALTER TABLE stock_movements RENAME TO inventory_log;
-- COMMIT;
-- =============================================================================
