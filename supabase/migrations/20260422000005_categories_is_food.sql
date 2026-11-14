-- Add is_food flag for KDS printer routing (food → KDS, drinks → printer)
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS is_food BOOLEAN NOT NULL DEFAULT false;
