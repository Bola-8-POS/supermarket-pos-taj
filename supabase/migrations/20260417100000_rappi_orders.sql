-- Rappi delivery orders (webhook ingest + POS workflow)

CREATE TYPE rappi_order_status AS ENUM (
  'pending_acceptance',
  'accepted',
  'preparing',
  'ready_for_pickup',
  'completed',
  'rejected'
);

CREATE TABLE rappi_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rappi_order_id VARCHAR(128) NOT NULL,
  tab_id UUID REFERENCES tabs(id) ON DELETE SET NULL,
  status rappi_order_status NOT NULL DEFAULT 'pending_acceptance',
  customer_name VARCHAR(255) NOT NULL DEFAULT '',
  delivery_address TEXT NOT NULL DEFAULT '',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal NUMERIC(10, 2) NOT NULL,
  rappi_total NUMERIC(10, 2) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  rejection_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rappi_orders_rappi_order_id_unique UNIQUE (rappi_order_id),
  CONSTRAINT rappi_orders_subtotal_nonneg CHECK (subtotal >= 0),
  CONSTRAINT rappi_orders_rappi_total_nonneg CHECK (rappi_total >= 0)
);

CREATE INDEX idx_rappi_orders_status ON rappi_orders(status);
CREATE INDEX idx_rappi_orders_tenant_id ON rappi_orders(tenant_id);
CREATE INDEX idx_rappi_orders_received_at ON rappi_orders(received_at DESC);
CREATE INDEX idx_rappi_orders_tab_id ON rappi_orders(tab_id) WHERE tab_id IS NOT NULL;

-- Realtime for POS clients
ALTER PUBLICATION supabase_realtime ADD TABLE rappi_orders;

-- Fixed catalog anchor: each Rappi line maps to order_items with notes = Rappi dish name
INSERT INTO categories (id, name, color, sort_order)
VALUES (
  'a0000001-0000-4000-8000-000000000001',
  'Delivery integrations',
  '#6B7280',
  999
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, name, category_id, base_price, is_active, sku)
VALUES (
  'a0000002-0000-4000-8000-000000000002',
  'Rappi / external item',
  'a0000001-0000-4000-8000-000000000001',
  0.00,
  true,
  'RAPPI-LINE-ITEM'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory (product_id, quantity_on_hand, low_stock_threshold)
VALUES ('a0000002-0000-4000-8000-000000000002', 999999, 0)
ON CONFLICT (product_id) DO NOTHING;

CREATE TRIGGER update_rappi_orders_updated_at BEFORE UPDATE ON rappi_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE rappi_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rappi_orders_select_authenticated" ON rappi_orders
  FOR SELECT
  TO authenticated
  USING (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);

CREATE POLICY "rappi_orders_update_authenticated" ON rappi_orders
  FOR UPDATE
  TO authenticated
  USING (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid)
  WITH CHECK (tenant_id = '00000000-0000-0000-0000-000000000001'::uuid);
