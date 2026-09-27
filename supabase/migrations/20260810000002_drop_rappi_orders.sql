-- =============================================================================
-- Phase 1 (strip-rebrand), Plan 05 Task 2: [BLOCKING] destructive drop of the
-- Rappi delivery order integration (D-09 — "Rappi delivery... entirely out of
-- scope for grocery").
--
-- Paired follow-up to Plan 05 Task 1, which deleted every src/ and
-- supabase/functions/ file that read/wrote this table (the rappi-order
-- entity, RappiOrdersPanel widget, /rappi page, rappi-sync-menu and
-- rappi-webhook edge functions). Nothing in the codebase references
-- rappi_orders after this migration lands.
--
-- No function or trigger body references rappi_orders beyond what CASCADE
-- already removes (checked: only RLS policies from 20260417100000_rappi_orders
-- and 20260510000001_rls_rewrite_phase13, and the update_rappi_orders_updated_at
-- trigger, which is attached directly to the table — all dropped automatically
-- by DROP TABLE ... CASCADE, no separate DROP FUNCTION/TRIGGER needed).
--
-- The Rappi payment-method value on tabs/payments (tab.rappi_order_id column,
-- payment method enum 'rappi') is explicitly OUT of scope for this migration —
-- it stays reachable dead code per the plan's scope note, revisit separately
-- if full removal is ever desired.
-- =============================================================================

-- UP:
BEGIN;

-- Realtime publication membership must be dropped before the table itself.
-- Note: unlike ADD TABLE, PostgreSQL's ALTER PUBLICATION ... DROP TABLE does
-- not support IF EXISTS (neither for the publication membership nor the
-- table) — DO block below makes the drop idempotent by hand.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'rappi_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE rappi_orders;
  END IF;
END $$;

DROP TABLE IF EXISTS rappi_orders CASCADE;

DROP TYPE IF EXISTS rappi_order_status;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- DOWN:
-- BEGIN;
--
-- CREATE TYPE rappi_order_status AS ENUM (
--   'pending_acceptance',
--   'accepted',
--   'preparing',
--   'ready_for_pickup',
--   'completed',
--   'rejected'
-- );
--
-- CREATE TABLE rappi_orders (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   rappi_order_id VARCHAR(128) NOT NULL,
--   tab_id UUID REFERENCES tabs(id) ON DELETE SET NULL,
--   status rappi_order_status NOT NULL DEFAULT 'pending_acceptance',
--   customer_name VARCHAR(255) NOT NULL DEFAULT '',
--   delivery_address TEXT NOT NULL DEFAULT '',
--   items JSONB NOT NULL DEFAULT '[]'::jsonb,
--   subtotal NUMERIC(10, 2) NOT NULL,
--   rappi_total NUMERIC(10, 2) NOT NULL,
--   received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   accepted_at TIMESTAMPTZ,
--   completed_at TIMESTAMPTZ,
--   tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
--   rejection_reason TEXT,
--   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   CONSTRAINT rappi_orders_rappi_order_id_unique UNIQUE (rappi_order_id),
--   CONSTRAINT rappi_orders_subtotal_nonneg CHECK (subtotal >= 0),
--   CONSTRAINT rappi_orders_rappi_total_nonneg CHECK (rappi_total >= 0)
-- );
--
-- CREATE INDEX idx_rappi_orders_status ON rappi_orders(status);
-- CREATE INDEX idx_rappi_orders_tenant_id ON rappi_orders(tenant_id);
-- CREATE INDEX idx_rappi_orders_received_at ON rappi_orders(received_at DESC);
-- CREATE INDEX idx_rappi_orders_tab_id ON rappi_orders(tab_id) WHERE tab_id IS NOT NULL;
--
-- ALTER PUBLICATION supabase_realtime ADD TABLE rappi_orders;
--
-- CREATE TRIGGER update_rappi_orders_updated_at BEFORE UPDATE ON rappi_orders
--   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--
-- ALTER TABLE rappi_orders ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "rappi_orders_select_bartender" ON rappi_orders
--   FOR SELECT TO authenticated
--   USING (get_user_role() IN ('cashier', 'manager', 'admin'));
--
-- CREATE POLICY "rappi_orders_update_bartender" ON rappi_orders
--   FOR UPDATE TO authenticated
--   USING (get_user_role() IN ('cashier', 'manager', 'admin'))
--   WITH CHECK (get_user_role() IN ('cashier', 'manager', 'admin'));
--
-- CREATE POLICY "rappi_orders_insert_admin" ON rappi_orders
--   FOR INSERT TO authenticated
--   WITH CHECK (get_user_role() IN ('manager', 'admin'));
--
-- CREATE POLICY "rappi_orders_delete_admin" ON rappi_orders
--   FOR DELETE TO authenticated
--   USING (get_user_role() = 'admin');
--
-- -- No data restoration — table shape only, matching repo convention.
--
-- COMMIT;
-- =============================================================================
