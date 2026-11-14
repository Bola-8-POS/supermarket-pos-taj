-- Phase 29 (Plan 29-11, owner choice shelf-column 2026-11-08): where a product sits in the store, so the local
-- assistant's product lookup can answer "where is the ghee". Free text such as 'Pasillo 3 / A', at most 40 chars,
-- NULL = not recorded. Existing products RLS covers the new column (select: any authenticated role; update:
-- manage_products via products_update_manager_admin), so no policy or grant changes here.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS shelf_location text
  CHECK (shelf_location IS NULL OR char_length(shelf_location) <= 40);
