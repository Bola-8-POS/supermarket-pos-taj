-- =============================================================================
-- S4-01, S4-02: Split Bill + Refund schema
--
-- Adds sub-tab support columns to tabs, creates refunds/refund_items tables,
-- extends payments with is_refund/refund_id, and fixes two CHECK constraints
-- that would otherwise block split and refund operations.
--
-- Depends on: 20260427000000_tab_status_split_enum.sql (must run first)
-- =============================================================================

-- UP:
BEGIN;

-- ============================================================
-- 1. tabs: add sub-tab columns
-- ============================================================
ALTER TABLE tabs
  ADD COLUMN IF NOT EXISTS parent_tab_id uuid REFERENCES tabs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS split_mode    text CHECK (split_mode IN ('item', 'evenly', 'by_person', 'by_amount')),
  ADD COLUMN IF NOT EXISTS split_label   text;

CREATE INDEX IF NOT EXISTS idx_tabs_parent_tab_id ON tabs(parent_tab_id)
  WHERE parent_tab_id IS NOT NULL;

-- ============================================================
-- 2. Fix closed_at_requires_closed_status CHECK to allow 'split'
--    Previous: (closed_at IS NULL AND status = 'open') OR ...
--    New:      (closed_at IS NULL AND status IN ('open', 'split')) OR ...
-- ============================================================
ALTER TABLE tabs DROP CONSTRAINT IF EXISTS closed_at_requires_closed_status;
ALTER TABLE tabs ADD CONSTRAINT closed_at_requires_closed_status CHECK (
  (closed_at IS NULL  AND status IN ('open', 'split')) OR
  (closed_at IS NOT NULL AND status IN ('closed', 'paid', 'voided'))
);

-- ============================================================
-- 3. New refunds table
-- ============================================================
CREATE TABLE IF NOT EXISTS refunds (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  original_payment_id uuid        NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  reason              text        NOT NULL CHECK (reason IN ('wrong_order', 'quality_issue', 'customer_complaint', 'billing_error', 'other')),
  amount              numeric(10,2) NOT NULL CHECK (amount > 0),
  created_by          uuid        NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refunds_original_payment_id ON refunds(original_payment_id);

-- RLS: only manager/admin can INSERT; all authenticated staff can SELECT
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "refunds_select_authenticated" ON refunds
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "refunds_insert_manager" ON refunds
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role IN ('manager', 'admin')
    )
  );

-- ============================================================
-- 4. New refund_items table
-- ============================================================
CREATE TABLE IF NOT EXISTS refund_items (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id     uuid        NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  order_item_id uuid        NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  qty           integer     NOT NULL CHECK (qty > 0),
  amount        numeric(10,2) NOT NULL CHECK (amount > 0),
  restock       boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_items_refund_id     ON refund_items(refund_id);
CREATE INDEX IF NOT EXISTS idx_refund_items_order_item_id ON refund_items(order_item_id);

ALTER TABLE refund_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "refund_items_select_authenticated" ON refund_items
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "refund_items_insert_manager" ON refund_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND role IN ('manager', 'admin')
    )
  );

-- ============================================================
-- 5. payments: add is_refund + refund_id columns
-- ============================================================
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS is_refund  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS refund_id  uuid    REFERENCES refunds(id) ON DELETE RESTRICT;

-- ============================================================
-- 6. Fix amount_positive CHECK to allow negative amounts on refund rows
--    Previous: CHECK (amount > 0)
--    New:      CHECK (amount > 0 OR is_refund = true)
-- ============================================================
ALTER TABLE payments DROP CONSTRAINT IF EXISTS amount_positive;
ALTER TABLE payments ADD CONSTRAINT amount_positive
  CHECK (amount > 0 OR is_refund = true);

COMMIT;
