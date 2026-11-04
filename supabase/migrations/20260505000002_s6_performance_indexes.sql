-- UP
-- Phase 8 S6-02: performance indexes for reporting queries

-- 1. stock_movements: ingredient ledger drilldown queries
CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient_ts
  ON stock_movements (ingredient_id, created_at DESC)
  WHERE ingredient_id IS NOT NULL;

-- 2. waitlist_entries: composite for reporting + FIFO queue queries
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_status_created_at
  ON waitlist_entries (status, created_at DESC);

-- DOWN:
-- BEGIN;
-- DROP INDEX IF EXISTS idx_waitlist_entries_status_created_at;
-- DROP INDEX IF EXISTS idx_stock_movements_ingredient_ts;
-- COMMIT;
