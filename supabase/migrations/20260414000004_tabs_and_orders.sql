-- =====================================================
-- TABS & ORDERS
-- =====================================================

-- Tabs
CREATE TABLE tabs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name VARCHAR(255),
  table_number INT,
  staff_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  status tab_status NOT NULL DEFAULT 'open',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_name_or_table CHECK (customer_name IS NOT NULL OR table_number IS NOT NULL),
  CONSTRAINT closed_at_requires_closed_status CHECK (
    (closed_at IS NULL AND status = 'open') OR
    (closed_at IS NOT NULL AND status IN ('closed', 'paid', 'voided'))
  )
);

CREATE INDEX idx_tabs_staff_id ON tabs(staff_id);
CREATE INDEX idx_tabs_shift_id ON tabs(shift_id);
CREATE INDEX idx_tabs_status ON tabs(status);
CREATE INDEX idx_tabs_opened_at ON tabs(opened_at DESC);
CREATE INDEX idx_tabs_table_number ON tabs(table_number) WHERE status = 'open';

-- Orders
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  status order_status NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_tab_id ON orders(tab_id);
CREATE INDEX idx_orders_staff_id ON orders(staff_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

-- Order Items
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INT NOT NULL DEFAULT 1,
  unit_price NUMERIC(10, 2) NOT NULL,
  modifier_ids UUID[] NOT NULL DEFAULT '{}',
  modifier_price_delta NUMERIC(10, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT quantity_positive CHECK (quantity > 0),
  CONSTRAINT unit_price_non_negative CHECK (unit_price >= 0)
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);
CREATE INDEX idx_order_items_created_at ON order_items(created_at DESC);
