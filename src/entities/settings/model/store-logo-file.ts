/**
 * Store-logo upload pipeline (Phase 33 Plan 02, D-07/D-08/D-09/D-10).
 * `validateStoreLogoFile`/`targetLogoDimensions`/`resizeStoreLogo`/
 * `storeLogoObjectPath` are pure, framework-free helpers adapted from
 * src/features/manage-products/model/photo-file.ts for a single,
 * store-wide singleton asset (no productId segment) instead of a
 * per-product one.
 *
 * `signStoreLogo`/`useStoreLogoUrl` are Storage/TanStack additions that
 * would not exist under this plan's default assumption (Option A: a public
 * bucket + a synchronous `getPublicUrl` string builder). Task 1's checkpoint
 * was resolved by the user to Option B — a private bucket
 * (`store-branding`, migration 20260911000002) with an anonymous SELECT
 * policy so the pre-auth login screen can still mint a signed URL. Under
 * Option B this file's public-URL builder is replaced by an async signer +
 * cache hook mirroring src/entities/product/model/resolveProductImage.ts's
 * single-row shape (TTL/staleTime constants copied verbatim).
 */
/* eslint-disable i18next/no-literal-string -- internal AppError sentinels
   ('unknownType'), the VALIDATION_ERROR message (not shown verbatim — the UI
   selects its own translated copy by AppErrorCode), MIME-type literals
   passed to canvas.toBlob(), and the query-key namespace string; none of
   this file's strings are rendered UI copy. */
import { useQuery } from '@tanstack/react-query';
import { logger } from '@shared/lib/logger-instance';
import {
  err,
  ok,
  photoDecodeFailedError,
  photoTooLargeError,
  supabaseError,
  unknownError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

export const STORE_BRANDING_BUCKET = 'store-branding';
export const ACCEPTED_LOGO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
// WR-02: must not exceed the store-branding bucket's server-side
// file_size_limit (2097152 bytes, migration 20260911000002) — otherwise an
// admin sees only a generic upload-failed error after a full decode+resize
// round-trip instead of an upfront "too large" rejection.
export const MAX_LOGO_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Signed-URL lifetime handed to Storage — copied from resolveProductImage.ts (mirror, don't invent). */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;
/** Re-sign before the TTL expires — TanStack Query staleTime for the signed-URL cache. */
export const SIGNED_URL_STALE_TIME_MS = 45 * 60 * 1000;

const MAX_EDGE_PX = 800; // D-07: hero login display, not close-up product inspection (smaller than Phase 31's product-photo constant)
const ENCODE_QUALITY = 0.8; // D-08: unchanged from Phase 31
const UNKNOWN_TYPE_SENTINEL = 'unknownType';

function bytesToMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function declaredType(file: File): string {
  return file.type === '' ? UNKNOWN_TYPE_SENTINEL : file.type;
}

/**
 * Validates a picked/dropped/pasted logo file against D-08's accepted-type
 * and size rules. Does not attempt to decode the bytes — see
 * resizeStoreLogo for the decode-failure path.
 */
export function validateStoreLogoFile(file: File): Result<File> {
  const type = file.type;
  if (!(ACCEPTED_LOGO_MIME_TYPES as readonly string[]).includes(type)) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'Unsupported photo format.',
      detail: declaredType(file),
    });
  }
  if (file.size > MAX_LOGO_UPLOAD_BYTES) {
    return err(photoTooLargeError(bytesToMb(file.size)));
  }
  return ok(file);
}

/**
 * Scales { width, height } down so the longest edge is at most MAX_EDGE_PX
 * (800, D-07), preserving aspect ratio. The short edge is always rounded to
 * an integer — canvas dimensions cannot be fractional.
 */
export function targetLogoDimensions({
  width,
  height,
}: {
  width: number;
  height: number;
}): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE_PX) {
    return { width, height };
  }
  const scale = MAX_EDGE_PX / longest;
  if (width >= height) {
    return { width: MAX_EDGE_PX, height: Math.round(height * scale) };
  }
  return { width: Math.round(width * scale), height: MAX_EDGE_PX };
}

/**
 * Mints a fresh Storage object key for the store-wide singleton logo. Built
 * only from a generated uuid — File.name is never read into the key
 * (path-traversal prevention). uuid-per-upload (not a stable
 * `store/logo.ext`) keeps `upsert: false` valid in useStoreLogoUpload and
 * matches its delete-previous-object-last sequence.
 */
export function storeLogoObjectPath(ext: string): string {
  return `store/${crypto.randomUUID()}.${ext}`;
}

/**
 * Decodes, downscales, and re-encodes a logo file before upload: one stored
 * size only (800px max edge, D-07), WebP preferred with a JPEG fallback when
 * toBlob yields null for WebP. Every failure returns a distinguishable
 * AppError instead of letting the promise reject.
 */
export async function resizeStoreLogo(
  file: File
): Promise<Result<{ blob: Blob; ext: 'webp' | 'jpg' }>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return err(photoDecodeFailedError(declaredType(file)));
  }

  try {
    const { width, height } = targetLogoDimensions({ width: bitmap.width, height: bitmap.height });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return err(photoDecodeFailedError(declaredType(file)));
    }
    ctx.drawImage(bitmap, 0, 0, width, height);

    const webpBlob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/webp', ENCODE_QUALITY);
    });
    if (webpBlob) return ok({ blob: webpBlob, ext: 'webp' });

    const jpegBlob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', ENCODE_QUALITY);
    });
    if (jpegBlob) return ok({ blob: jpegBlob, ext: 'jpg' });

    return err(photoDecodeFailedError(declaredType(file)));
  } finally {
    bitmap.close();
  }
}

/**
 * Mints a signed URL for an object in the store-branding bucket (Option B:
 * private bucket + anon SELECT policy, migration 20260911000002). Never
 * throws — Storage responses are not Postgrest builders, so they're wrapped
 * by hand in ok/err here rather than through supabaseMutation/supabaseQuery,
 * matching resolveProductImage.ts's signProductPhoto.
 */
export async function signStoreLogo(path: string): Promise<Result<string>> {
  try {
    const { data, error } = await supabase.storage
      .from(STORE_BRANDING_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error) {
      logger.error('settings.store_logo.sign_failed', { message: error.message, path });
      return err(supabaseError(error.message, undefined, error));
    }
    return ok(data.signedUrl);
  } catch (e) {
    logger.error('settings.store_logo.sign_failed', {
      message: e instanceof Error ? e.message : String(e),
      path,
    });
    return err(unknownError(e));
  }
}

/**
 * TanStack Query hook for the single store logo. Keyed by the path itself so
 * an upload/replace/remove naturally produces a fresh query with no manual
 * invalidation. `isLoading` is false when there is no path at all, so the
 * D-03 fallback (generic name + icon) renders immediately — no skeleton
 * flash on an unconfigured store.
 */
export function useStoreLogoUrl(path: string | null): { url: string | null; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['store-logo-url', path],
    queryFn: async () => {
      if (!path) return null;
      const signed = await signStoreLogo(path);
      return signed.ok ? signed.data : null;
    },
    staleTime: SIGNED_URL_STALE_TIME_MS,
  });

  return {
    url: query.data ?? null,
    isLoading: !!path && query.isPending,
  };
}
