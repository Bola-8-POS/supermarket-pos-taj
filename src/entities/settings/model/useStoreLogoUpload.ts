/**
 * Upload/replace and remove mutations for the store-wide login-hero logo
 * (Phase 33 Plan 02). Sequence adapted from
 * src/features/manage-products/model/useProductPhotoUpload.ts: isOnline
 * guard -> validate -> resize -> Storage upload -> link -> delete the
 * previous object last.
 *
 * The one required divergence (33-RESEARCH.md Pitfall 2): there is no
 * `photo_path` column here — `storeLogoPath` lives inside the whole-blob
 * `general` JSONB settings value, and `useMutationUpdateSetting` always
 * upserts that entire value. The link step therefore reads the current
 * `general` snapshot out of the TanStack Query cache and spreads it before
 * writing, so a logo write never blanks the store name/address/timezone/
 * currency/receipt footer stored alongside it.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { isOnline } from '@shared/lib/connectivity';
import { logger } from '@shared/lib/logger-instance';
import {
  err,
  networkOfflineError,
  ok,
  photoLinkFailedError,
  photoRemoveFailedError,
  photoUploadFailedError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';
import type { SettingsSnapshot } from './queries';
import { useMutationUpdateSetting } from './queries';
import { resizeStoreLogo, storeLogoObjectPath, STORE_BRANDING_BUCKET, validateStoreLogoFile } from './store-logo-file';
import type { GeneralSettings } from './types';

/* eslint-disable i18next/no-literal-string -- MIME-type literals, the
   settings query-key literal, and the AppError `detail` string below (a
   technical log/detail value per result.ts's AppError doc-comment — "log
   only, never show to user" — not UI copy) */
const WEBP_CONTENT_TYPE = 'image/webp';
const JPEG_CONTENT_TYPE = 'image/jpeg';
const SETTINGS_QUERY_KEY = ['settings'];
const NO_CACHED_SNAPSHOT_DETAIL = 'No cached general settings snapshot to merge into';
/* eslint-enable i18next/no-literal-string */

/**
 * Reads the current `general` blob out of the query cache so the link step
 * can spread it rather than overwrite the whole row. Returns null when no
 * snapshot is cached yet (e.g. useSettings() hasn't resolved) — callers must
 * fail the mutation rather than write a partial blob in that case.
 */
function currentGeneralSnapshot(queryClient: QueryClient): GeneralSettings | null {
  const cached = queryClient.getQueryData<Result<SettingsSnapshot>>(SETTINGS_QUERY_KEY);
  return cached?.ok ? cached.data.general : null;
}

export type StoreLogoUploadInput = {
  previousPath: string | null;
  file: File;
  /** Lets the UI distinguish the resize phase from the network-upload phase. */
  onStageChange?: (stage: 'processing' | 'uploading') => void;
};

export function useStoreLogoUpload() {
  const queryClient = useQueryClient();
  const updateSetting = useMutationUpdateSetting();

  return useMutation({
    mutationFn: async (input: StoreLogoUploadInput): Promise<Result<{ path: string }>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }

      const validated = validateStoreLogoFile(input.file);
      if (!validated.ok) return validated;

      input.onStageChange?.('processing');
      const resized = await resizeStoreLogo(validated.data);
      if (!resized.ok) return resized;

      input.onStageChange?.('uploading');
      const path = storeLogoObjectPath(resized.data.ext);
      const contentType = resized.data.ext === 'webp' ? WEBP_CONTENT_TYPE : JPEG_CONTENT_TYPE;

      const { error: uploadError } = await supabase.storage
        .from(STORE_BRANDING_BUCKET)
        .upload(path, resized.data.blob, { contentType, upsert: false });
      if (uploadError) {
        logger.error('settings.store_logo.upload_failed', { message: uploadError.message, path });
        return err(photoUploadFailedError(uploadError.message, uploadError));
      }

      const current = currentGeneralSnapshot(queryClient);
      if (!current) {
        logger.error('settings.store_logo.link_failed', {
          message: NO_CACHED_SNAPSHOT_DETAIL,
          path,
        });
        return err(photoLinkFailedError(NO_CACHED_SNAPSHOT_DETAIL));
      }

      const linkResult = await updateSetting.mutateAsync({
        key: 'general',
        value: { ...current, storeLogoPath: path },
      });
      if (!linkResult.ok) {
        logger.error('settings.store_logo.link_failed', { message: linkResult.error.message, path });
        // WR-01: the just-uploaded object is now unlinked -- attempt to clean
        // it up, and if that also fails, log it as an orphan the same way the
        // old-object delete path below does, instead of leaving it untracked.
        const { error: cleanupError } = await supabase.storage
          .from(STORE_BRANDING_BUCKET)
          .remove([path]);
        if (cleanupError) {
          logger.warn('settings.store_logo.unlinked_object_orphaned', {
            path,
            message: cleanupError.message,
          });
        }
        return err(photoLinkFailedError(linkResult.error.message, linkResult.error));
      }

      if (input.previousPath) {
        const { error: removeError } = await supabase.storage
          .from(STORE_BRANDING_BUCKET)
          .remove([input.previousPath]);
        if (removeError) {
          // Reported to the user as success (the new logo is live and linked) —
          // the old object is merely orphaned, not a broken reference. Logged so
          // it can be reclaimed later.
          logger.warn('settings.store_logo.old_object_orphaned', {
            path: input.previousPath,
            message: removeError.message,
          });
        }
      }

      return ok({ path });
    },
  });
}

export type StoreLogoRemoveInput = {
  /** Always the path already stored in general.storeLogoPath — never a caller-supplied string. */
  path: string;
};

/**
 * Removes the store logo: clears general.storeLogoPath first, then deletes
 * the Storage object. A failed object delete after a successful clear is a
 * logged orphan, not a user-facing error — the same precedent as the upload
 * path's old-object delete above, since nothing references the object
 * anymore either way.
 */
export function useRemoveStoreLogo() {
  const queryClient = useQueryClient();
  const updateSetting = useMutationUpdateSetting();

  return useMutation({
    mutationFn: async (input: StoreLogoRemoveInput): Promise<Result<void>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }

      const current = currentGeneralSnapshot(queryClient);
      if (!current) {
        logger.error('settings.store_logo.remove_link_failed', {
          message: NO_CACHED_SNAPSHOT_DETAIL,
        });
        return err(photoRemoveFailedError(NO_CACHED_SNAPSHOT_DETAIL));
      }

      const linkResult = await updateSetting.mutateAsync({
        key: 'general',
        value: { ...current, storeLogoPath: null },
      });
      if (!linkResult.ok) {
        logger.error('settings.store_logo.remove_link_failed', { message: linkResult.error.message });
        return err(photoRemoveFailedError(linkResult.error.message, linkResult.error));
      }

      const { error: removeError } = await supabase.storage
        .from(STORE_BRANDING_BUCKET)
        .remove([input.path]);
      if (removeError) {
        logger.warn('settings.store_logo.remove_object_orphaned', {
          path: input.path,
          message: removeError.message,
        });
      }

      return ok(undefined);
    },
  });
}
