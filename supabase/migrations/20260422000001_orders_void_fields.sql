-- Add void tracking columns to orders table.
-- void_reason: the reason string entered by staff when voiding
-- voided_at: the timestamp when the order was voided
-- voided_by: which staff member performed the void
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_voided_at
  ON orders(voided_at)
  WHERE status = 'voided';
