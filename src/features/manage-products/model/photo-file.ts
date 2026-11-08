/**
 * Pure, framework-free helpers for the product-photo upload pipeline
 * (Phase 31, D-10/D-11). No React, no Supabase — see useProductPhotoUpload.ts
 * for the Storage/DB wiring that consumes these.
 */
/* eslint-disable i18next/no-literal-string -- internal AppError sentinels
   ('unknownType'), the VALIDATION_ERROR message (not shown verbatim — the UI
   selects its own translated copy by AppErrorCode), and MIME-type literals
   passed to canvas.toBlob(); none of this file's strings are rendered UI copy. */
import { err, ok, photoDecodeFailedError, photoTooLargeError, type Result } from '@shared/lib/result';

export const ACCEPTED_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const MAX_EDGE_PX = 1200;
const ENCODE_QUALITY = 0.8;
const UNKNOWN_TYPE_SENTINEL = 'unknownType';

function bytesToMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function declaredType(file: File): string {
  return file.type === '' ? UNKNOWN_TYPE_SENTINEL : file.type;
}

/**
 * Validates a picked/dropped/pasted file against D-11's accepted-type and
 * size rules. Does not attempt to decode the bytes — see resizePhoto for
 * the decode-failure path (Pitfall 5).
 */
export function validatePhotoFile(file: File): Result<File> {
  const type = file.type;
  if (!(ACCEPTED_PHOTO_MIME_TYPES as readonly string[]).includes(type)) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'Unsupported photo format.',
      detail: declaredType(file),
    });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return err(photoTooLargeError(bytesToMb(file.size)));
  }
  return ok(file);
}

/**
 * Scales { width, height } down so the longest edge is at most MAX_EDGE_PX,
 * preserving aspect ratio. The short edge is always rounded to an integer —
 * canvas dimensions cannot be fractional.
 */
export function targetDimensions({
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
 * Structural subset of a DOM `DataTransferItem` — deliberately duck-typed
 * rather than importing the lib.dom interface so callers (drag events,
 * clipboard paste events, and unit tests) can all pass real or plain-object
 * item lists without a jsdom DataTransferItem constructor.
 */
export interface DataTransferItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile(): File | null;
}

/**
 * Returns the first image entry in a drag-and-drop item list — including one
 * whose type is unsupported, so the caller's `validatePhotoFile` can name the
 * offending type in its error (D-11) instead of the drop being silently
 * ignored the way `agent-chat/FileDropZone` does today. Returns null when no
 * item is an image at all.
 */
export function firstImageFromDataTransfer(
  items: Iterable<DataTransferItemLike> | ArrayLike<DataTransferItemLike> | null | undefined
): File | null {
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/**
 * Same extraction as `firstImageFromDataTransfer`, applied to a paste event's
 * `clipboardData`.
 */
export function firstImageFromClipboard(
  clipboardData:
    | { items?: Iterable<DataTransferItemLike> | ArrayLike<DataTransferItemLike> | null }
    | null
    | undefined
): File | null {
  return firstImageFromDataTransfer(clipboardData?.items ?? null);
}

/**
 * Mints a fresh Storage object key. Built only from productId and a generated
 * uuid — File.name is never read into the key (path-traversal prevention).
 */
export function photoObjectPath(productId: string, ext: string): string {
  return `products/${productId}/${crypto.randomUUID()}.${ext}`;
}

/**
 * Decodes, downscales, and re-encodes a photo file before upload (D-10):
 * one stored size only, WebP preferred with a JPEG fallback when toBlob
 * yields null for WebP. Every failure returns a distinguishable AppError
 * instead of letting the promise reject (Pitfall 5).
 */
export async function resizePhoto(
  file: File
): Promise<Result<{ blob: Blob; ext: 'webp' | 'jpg' }>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return err(photoDecodeFailedError(declaredType(file)));
  }

  try {
    const { width, height } = targetDimensions({ width: bitmap.width, height: bitmap.height });
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
