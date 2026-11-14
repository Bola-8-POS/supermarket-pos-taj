-- Purchase Orders schema (Phase 16, Plan 01 — PO-01/PO-03).
-- purchase_orders/purchase_order_items: manager+-only draft->received lifecycle.
-- RLS deliberately uses FOR ALL (not a separate open SELECT USING(true)
-- policy like `suppliers` has) so D-02's "cashiers cannot see purchase
-- orders at all" is enforced at the RLS layer, not just client-side.

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'received')),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE RESTRICT,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_purchase_orders_supplier ON purchase_orders (supplier_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders (status);
CREATE TRIGGER update_purchase_orders_updated_at BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  cost_price numeric(10,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0)
);
CREATE INDEX idx_purchase_order_items_po ON purchase_order_items (purchase_order_id);

-- Nullable back-reference so a shipment can be traced to the PO that
-- generated it (RESEARCH.md Pitfall 5 / Assumption A2) — cheap now, avoids
-- a later migration once real PO rows exist.
ALTER TABLE shipments ADD COLUMN po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL;

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY purchase_orders_manage ON purchase_orders FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));
CREATE POLICY purchase_order_items_manage ON purchase_order_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'))
  WITH CHECK (EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products'));

-- DOWN: drop RLS policies; drop shipments.po_id column; drop
-- purchase_order_items and purchase_orders tables (and their
-- indexes/triggers, dropped automatically with the tables).
