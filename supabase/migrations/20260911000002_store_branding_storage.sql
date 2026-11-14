-- Phase 33 Plan 02: store-logo Storage bucket + RLS.
--
-- Decision (33-02 Task 1 checkpoint, resolved by the user as Option B):
-- private bucket ("store-branding", public = false), mirroring Phase 31's
-- product-photos bucket shape exactly, PLUS an anon SELECT policy so the
-- pre-auth login screen (rendered with no session, per 20260911000001's
-- anon settings-read policy) can mint a signed URL for the logo object.
-- Rejected: a public bucket + synchronous getPublicUrl() (Option A) — Option
-- B was chosen to mirror Phase 31's file layout and its resolveProductImage.ts
-- TTL/staleTime constants exactly, per 33-CONTEXT.md's discretion note.
--
-- No new column: storeLogoPath lives inside the existing JSONB
-- settings.value blob (key='general'), added to GeneralSettingsSchema in
-- plan 01 — see 33-RESEARCH.md Pitfall 2.
--
-- Idempotent by design: bucket insert is ON CONFLICT DO NOTHING, and every
-- policy is dropped-if-present before being recreated, so re-running this
-- migration is a no-op.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'store-branding',
  'store-branding',
  false,                                -- private bucket, matches product-photos (Option B)
  2097152,                              -- 2 MB server-side backstop (client always re-encodes before upload)
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- SELECT: anon + authenticated, bucket_id predicate only — matches the
-- Phase 31 SELECT shape, widened to anon so the unauthenticated login
-- screen can sign the logo URL. This is what makes Option B's async
-- signed-URL resolver viable pre-auth.
DROP POLICY IF EXISTS store_branding_select ON storage.objects;
CREATE POLICY store_branding_select ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id = 'store-branding'
  );

DROP POLICY IF EXISTS store_branding_insert ON storage.objects;
CREATE POLICY store_branding_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'store-branding'
    AND EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_settings')
  );

DROP POLICY IF EXISTS store_branding_update ON storage.objects;
CREATE POLICY store_branding_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'store-branding'
    AND EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_settings')
  )
  WITH CHECK (
    bucket_id = 'store-branding'
    AND EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_settings')
  );

DROP POLICY IF EXISTS store_branding_delete ON storage.objects;
CREATE POLICY store_branding_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'store-branding'
    AND EXISTS (SELECT 1 FROM role_permissions WHERE role = get_user_role() AND action = 'manage_settings')
  );

COMMIT;
-- No DOWN script (repo convention — all post-pivot migrations are forward-only).
