-- ============================================================================
-- SOFT DELETE COLUMNS
-- Nothing is ever hard-deleted. Records are marked with deleted_at / is_deleted.
-- All application-level deletes must set is_deleted=TRUE, deleted_at=now().
-- ============================================================================

-- tabs
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS tabs_is_deleted_idx ON tabs (is_deleted) WHERE is_deleted = FALSE;

-- orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS orders_is_deleted_idx ON orders (is_deleted) WHERE is_deleted = FALSE;

-- order_items
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS payments_is_deleted_idx ON payments (is_deleted) WHERE is_deleted = FALSE;

-- pool_sessions
ALTER TABLE pool_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pool_sessions ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- pool_tables
ALTER TABLE pool_tables ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pool_tables ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- profiles (staff) — use existing is_active, add deleted_at for audit trail
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- products & categories
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
