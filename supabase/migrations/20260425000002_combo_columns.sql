-- =============================================================================
-- S2-02: Extend order_items, pool_sessions, products with combo columns
-- =============================================================================

-- UP: extend order_items, pool_sessions, products with combo columns
BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS parent_order_item_id uuid REFERENCES order_items(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS combo_slot_id uuid REFERENCES combo_slots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_parent_order_item_id ON order_items(parent_order_item_id)
  WHERE parent_order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_combo_slot_id ON order_items(combo_slot_id)
  WHERE combo_slot_id IS NOT NULL;

ALTER TABLE pool_sessions
  ADD COLUMN IF NOT EXISTS prepaid_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_order_item_id uuid REFERENCES order_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pool_sessions_source_order_item_id ON pool_sessions(source_order_item_id)
  WHERE source_order_item_id IS NOT NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS combo_price_override numeric(10,2);  -- null = sum of children

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- ALTER TABLE products DROP COLUMN IF EXISTS combo_price_override;
-- ALTER TABLE pool_sessions DROP COLUMN IF EXISTS source_order_item_id, DROP COLUMN IF EXISTS prepaid_minutes;
-- ALTER TABLE order_items DROP COLUMN IF EXISTS combo_slot_id, DROP COLUMN IF EXISTS parent_order_item_id;
-- COMMIT;
-- =============================================================================
