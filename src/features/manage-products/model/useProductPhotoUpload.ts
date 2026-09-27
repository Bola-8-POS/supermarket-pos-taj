/**
 * Upload/replace mutation for a single product photo (Phase 31, D-16).
 * Sequence: isOnline guard -> validate -> resize -> Storage upload ->
 * link (products.photo_path write) -> delete the previous object last.
 * Each stage returns its own distinguishable AppError so the UI can choose
 * between errorUpload / errorLink / a silent orphan on a failed old delete
 * (Pitfall 6) — upsert stays off so a replace can never overwrite a live key.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateCatalogQueries, PRODUCT_PHOTO_BUCKET } from '@entities/product';
import { isOnline } from '@shared/lib/connectivity';
import { logger } from '@shared/lib/logger-instance';
import {
  err,
  networkOfflineError,
  ok,
  photoLinkFailedError,
  photoRemoveFailedError,
  photoUploadFailedError,
  supabaseMutation,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import { photoObjectPath, resizePhoto, validatePhotoFile } from './photo-file';

/* eslint-disable i18next/no-literal-string -- MIME-type literals, not UI copy */
const WEBP_CONTENT_TYPE = 'image/webp';
const JPEG_CONTENT_TYPE = 'image/jpeg';
/* eslint-enable i18next/no-literal-string */

export type ProductPhotoUploadInput = {
  productId: string;
  previousPath: string | null;
  file: File;
  /** Lets the UI distinguish the resize (D-10) phase from the network-upload phase — see 31-UI-SPEC.md's Photo tab loading row. */
  onStageChange?: (stage: 'processing' | 'uploading') => void;
};

export function useProductPhotoUpload() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ProductPhotoUploadInput): Promise<Result<{ path: string }>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }

      const validated = validatePhotoFile(input.file);
      if (!validated.ok) return validated;

      input.onStageChange?.('processing');
      const resized = await resizePhoto(validated.data);
      if (!resized.ok) return resized;

      input.onStageChange?.('uploading');
      const path = photoObjectPath(input.productId, resized.data.ext);
      const contentType = resized.data.ext === 'webp' ? WEBP_CONTENT_TYPE : JPEG_CONTENT_TYPE;

      const { error: uploadError } = await supabase.storage
        .from(PRODUCT_PHOTO_BUCKET)
        .upload(path, resized.data.blob, { contentType, upsert: false });
      if (uploadError) {
        logger.error('product.photo.upload_failed', { message: uploadError.message, path });
        return err(photoUploadFailedError(uploadError.message, uploadError));
      }

      const linkResult = await supabaseMutation(() =>
        supabase.from('products').update({ photo_path: path }).eq('id', input.productId).select('id').single()
      );
      if (!linkResult.ok) {
        logger.error('product.photo.link_failed', {
          message: linkResult.error.message,
          path,
          productId: input.productId,
        });
        return err(photoLinkFailedError(linkResult.error.message, linkResult.error));
      }

      if (input.previousPath) {
        const { error: removeError } = await supabase.storage
          .from(PRODUCT_PHOTO_BUCKET)
          .remove([input.previousPath]);
        if (removeError) {
          // Reported to the user as success (the new photo is live and linked) —
          // the old object is merely orphaned, not a broken reference. Logged so
          // it can be reclaimed later.
          logger.warn('product.photo.old_object_orphaned', {
            path: input.previousPath,
            message: removeError.message,
          });
        }
      }

      return ok({ path });
    },
    onSuccess: result => {
      if (result.ok) invalidateCatalogQueries(queryClient);
    },
  });
}

export type ProductPhotoRemoveInput = {
  productId: string;
  /** Always the path already stored on the product row (T-31-15) — never a caller-supplied string. */
  path: string;
};

/**
 * Removes a product's photo (D-12): clears `products.photo_path` first, then
 * deletes the Storage object. Column-clear failure leaves everything
 * untouched (photo stays in place, retryable). A failed object delete after
 * a successful column-clear is a logged orphan, not a user-facing error —
 * the same precedent as the upload path's old-object delete above, since
 * nothing references the object anymore either way.
 */
export function useRemoveProductPhoto() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ProductPhotoRemoveInput): Promise<Result<void>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }

      const linkResult = await supabaseMutation(() =>
        supabase
          .from('products')
          .update({ photo_path: null })
          .eq('id', input.productId)
          .select('id')
          .single()
      );
      if (!linkResult.ok) {
        logger.error('product.photo.remove_link_failed', {
          message: linkResult.error.message,
          productId: input.productId,
        });
        return err(photoRemoveFailedError(linkResult.error.message, linkResult.error));
      }

      const { error: removeError } = await supabase.storage
        .from(PRODUCT_PHOTO_BUCKET)
        .remove([input.path]);
      if (removeError) {
        logger.warn('product.photo.remove_object_orphaned', {
          path: input.path,
          message: removeError.message,
        });
      }

      return ok(undefined);
    },
    onSuccess: result => {
      if (result.ok) invalidateCatalogQueries(queryClient);
    },
  });
}
