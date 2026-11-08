-- Phase 31 Plan 01: Product photo Storage bucket + RLS + products.photo_path
--
-- Decision A (31-01 Task 1): column is `photo_path`, a bare Storage object
-- path (e.g. products/{productId}/{uuid}.webp), NOT a URL.
-- Decision B (31-01 Task 1): SELECT is open to any `authenticated` role for
-- this bucket (no manage_products predicate) -- forward-looking for a future
-- cashier-facing photo surface; zero display benefit this phase (see
-- 31-01-SUMMARY.md must_haves.truths). INSERT/UPDATE/DELETE keep the
-- manage_products predicate, copied verbatim from
-- 20260823000001_purchase_orders.sql:39-43.
--
-- Idempotent by design: bucket insert is ON CONFLICT DO NOTHING, the column
-- add is IF NOT EXISTS, and every policy is dropped-if-present before being
-- recreated, so re-running this migration is a no-op.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-photos',
  'product-photos',
  false,                               -- private bucket (D-15)
  2097152,                             -- 2 MB server-side backstop (D-11)
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS photo_path text;   -- nullable; a Storage object path, not a URL (Pitfall 3)

DROP POLICY IF EXISTS product_photos_select ON storage.objects;
CREATE POLICY product_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'product-photos'
  );

DROP POLICY IF EXISTS product_photos_insert ON storage.objects;
CREATE POLICY product_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'product-photos'
    AND EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products')
  );

DROP POLICY IF EXISTS product_photos_update ON storage.objects;
CREATE POLICY product_photos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'product-photos'
    AND EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products')
  )
  WITH CHECK (
    bucket_id = 'product-photos'
    AND EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products')
  );

DROP POLICY IF EXISTS product_photos_delete ON storage.objects;
CREATE POLICY product_photos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'product-photos'
    AND EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_products')
  );

COMMIT;
-- No DOWN script (CLAUDE.md convention -- post-pivot migrations ship forward-only).
