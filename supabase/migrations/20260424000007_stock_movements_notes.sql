-- Add notes column to stock_movements for manual adjustment context.
-- Used by record_stock_movement RPC (p_notes parameter).

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS notes TEXT NULL;
