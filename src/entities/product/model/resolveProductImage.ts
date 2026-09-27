/**
 * D-14: the single shared answer to "which product image wins" — uploaded
 * photo wins, legacy free-text imageUrl is the fallback, null (placeholder)
 * when both are absent. Lives in entities/product because widgets/ and other
 * entities/* consumers may not import from features/ (FSD boundary).
 *
 * Storage responses are not Postgrest builders, so they're wrapped by hand
 * in ok/err here rather than through supabaseMutation/supabaseQuery.
 */
import { useQuery } from '@tanstack/react-query';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, supabaseError, unknownError, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { Product } from './types';

export const PRODUCT_PHOTO_BUCKET = 'product-photos';
/** Signed-URL lifetime handed to Storage (D-16). */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;
/** Re-sign before the TTL expires — TanStack Query staleTime for the signed-URL cache. */
export const SIGNED_URL_STALE_TIME_MS = 45 * 60 * 1000;

/** Mints a signed URL for a Storage object path. */
export async function signProductPhoto(path: string): Promise<Result<string>> {
  try {
    const { data, error } = await supabase.storage
      .from(PRODUCT_PHOTO_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error) {
      logger.error('product.photo.sign_failed', { message: error.message, path });
      return err(supabaseError(error.message, undefined, error));
    }
    return ok(data.signedUrl);
  } catch (e) {
    logger.error('product.photo.sign_failed', {
      message: e instanceof Error ? e.message : String(e),
      path,
    });
    return err(unknownError(e));
  }
}

/** Pure precedence rule (D-14): a resolved signed URL wins, imageUrl is the fallback, else null. */
export function pickProductImage({
  signedUrl,
  imageUrl,
}: {
  signedUrl: string | null;
  imageUrl: string | null;
}): string | null {
  if (signedUrl) return signedUrl;
  return imageUrl ?? null;
}

/**
 * Resolves a single product's display image, signing photoPath on demand and
 * falling through to imageUrl (or null) on any signing failure — never a
 * broken/expired path string reaches the UI.
 */
export async function resolveProductImageUrl(product: {
  photoPath: string | null;
  imageUrl: string | null;
}): Promise<string | null> {
  const { photoPath, imageUrl } = product;
  if (!photoPath) {
    return pickProductImage({ signedUrl: null, imageUrl });
  }
  const signed = await signProductPhoto(photoPath);
  return pickProductImage({ signedUrl: signed.ok ? signed.data : null, imageUrl });
}

/**
 * TanStack Query hook for a single product's display image (dialog Photo
 * tab / catalog thumbnail). Keyed by product id + photoPath + imageUrl so an
 * upload/replace/remove naturally produces a fresh query with no manual
 * invalidation needed. The batch signed-URL path (list surfaces) is
 * `useProductImageUrls` below, not this hook.
 */
export function useProductImageUrl(
  product: Pick<Product, 'id' | 'photoPath' | 'imageUrl'>
): { url: string | null; isLoading: boolean } {
  const { id, photoPath, imageUrl } = product;
  const query = useQuery({
    // eslint-disable-next-line i18next/no-literal-string -- query-key namespace string, not UI copy
    queryKey: ['product-photo-url', id, photoPath, imageUrl],
    queryFn: () => resolveProductImageUrl({ photoPath, imageUrl }),
    staleTime: SIGNED_URL_STALE_TIME_MS,
  });

  return {
    url: query.data ?? null,
    isLoading: !!photoPath && query.isPending,
  };
}

/**
 * D-16 batch resolver for list surfaces (the catalog table, and any future
 * consumer with many rows on screen at once): one signed-URL request for
 * the whole page rather than one per row. De-duplicates and sorts the input
 * before the network call so a page with repeated paths still costs one
 * request, and a bad row never discards the rest of the page.
 */
export async function signProductPhotos(paths: string[]): Promise<Map<string, string>> {
  const uniquePaths = Array.from(new Set(paths)).sort();
  if (uniquePaths.length === 0) return new Map();

  try {
    const { data, error } = await supabase.storage
      .from(PRODUCT_PHOTO_BUCKET)
      .createSignedUrls(uniquePaths, SIGNED_URL_TTL_SECONDS);
    if (error) {
      logger.error('products.photo_sign_batch_failed', {
        message: error.message,
        count: uniquePaths.length,
      });
      return new Map();
    }
    const map = new Map<string, string>();
    for (const row of data) {
      if (row.path && !row.error) map.set(row.path, row.signedUrl);
    }
    return map;
  } catch (e) {
    logger.error('products.photo_sign_batch_failed', {
      message: e instanceof Error ? e.message : String(e),
      count: uniquePaths.length,
    });
    return new Map();
  }
}

function productImageUrlsQueryKey(paths: string[]): string[] {
  // eslint-disable-next-line i18next/no-literal-string -- query-key namespace string, not UI copy
  return ['product-photos-batch', ...paths];
}

/**
 * Batch TanStack Query hook for a page of rows (the catalog table, D-16).
 * Query key is the sorted, de-duplicated path list itself, so two renders
 * holding the same rows in a different order share one cache entry and
 * therefore one signing request.
 */
export function useProductImageUrls(
  products: readonly Pick<Product, 'photoPath'>[]
): { urls: Map<string, string>; isPending: boolean } {
  const uniquePaths = Array.from(
    new Set(products.map(p => p.photoPath).filter((p): p is string => !!p))
  ).sort();
  const query = useQuery({
    queryKey: productImageUrlsQueryKey(uniquePaths),
    queryFn: () => signProductPhotos(uniquePaths),
    staleTime: SIGNED_URL_STALE_TIME_MS,
    enabled: uniquePaths.length > 0,
  });

  return {
    urls: query.data ?? new Map<string, string>(),
    isPending: uniquePaths.length > 0 && query.isPending,
  };
}
