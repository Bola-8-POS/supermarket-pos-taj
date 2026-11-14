-- Add kitchen role to user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'kitchen';

-- Add kds_status enum type
CREATE TYPE kds_status AS ENUM ('pending', 'in_progress', 'done');

-- Add kds_status column to order_items (NOT NULL, default pending)
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS kds_status kds_status NOT NULL DEFAULT 'pending';

-- Partial index for KDS live query (non-done items only)
CREATE INDEX IF NOT EXISTS idx_order_items_kds_status
  ON order_items(kds_status)
  WHERE kds_status <> 'done';
