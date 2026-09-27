-- =====================================================
-- INVENTORY
-- =====================================================

-- Inventory
CREATE TABLE inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  quantity_on_hand INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 10,
  unit VARCHAR(50) NOT NULL DEFAULT 'unit',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT quantity_on_hand_non_negative CHECK (quantity_on_hand >= 0),
  CONSTRAINT low_stock_threshold_non_negative CHECK (low_stock_threshold >= 0)
);

CREATE INDEX idx_inventory_product_id ON inventory(product_id);
CREATE INDEX idx_inventory_low_stock ON inventory(product_id) WHERE quantity_on_hand <= low_stock_threshold;

-- Inventory Log
CREATE TABLE inventory_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_delta INT NOT NULL,
  reason VARCHAR(255) NOT NULL,
  staff_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_log_product_id ON inventory_log(product_id);
CREATE INDEX idx_inventory_log_staff_id ON inventory_log(staff_id);
CREATE INDEX idx_inventory_log_created_at ON inventory_log(created_at DESC);
