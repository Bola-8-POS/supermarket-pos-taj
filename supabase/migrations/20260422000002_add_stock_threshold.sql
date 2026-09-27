-- Add stock_threshold column to products table for low-stock alert feature.
-- Nullable so existing products default to NULL (no threshold = no alert).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_threshold numeric;
