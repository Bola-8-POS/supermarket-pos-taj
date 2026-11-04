import { useMutationUpdateReceiptSettings, type ReceiptSettings } from '@entities/settings';
import i18n from '@shared/lib/i18n';

const LOGO_MAX_BYTES = 200 * 1024;
const LOGO_MAX_WIDTH = 384;

export type LogoEncodeError =
  | { code: 'UNSUPPORTED_TYPE'; message: string }
  | { code: 'OVERSIZE'; message: string }
  | { code: 'DECODE_FAILED'; message: string };

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      // eslint-disable-next-line i18next/no-literal-string -- internal marker, never shown to the user
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}

export async function encodeLogoDataUrl(
  file: File
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: LogoEncodeError }> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_TYPE',
        message: i18n.t('featMgmt:uploadLogo.unsupportedType'),
      },
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, LOGO_MAX_WIDTH / img.naturalWidth);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        ok: false,
        error: { code: 'DECODE_FAILED', message: i18n.t('featMgmt:uploadLogo.canvasUnavailable') },
      };
    }
    ctx.drawImage(img, 0, 0, width, height);
    // eslint-disable-next-line i18next/no-literal-string -- MIME type identifiers, not UI copy
    const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const dataUrl = canvas.toDataURL(mime, mime === 'image/jpeg' ? 0.85 : undefined);
    const approxBytes = Math.ceil((dataUrl.length * 3) / 4);
    if (approxBytes > LOGO_MAX_BYTES) {
      return {
        ok: false,
        error: {
          code: 'OVERSIZE',
          message: i18n.t('featMgmt:uploadLogo.oversize', {
            kb: Math.round(LOGO_MAX_BYTES / 1024),
          }),
        },
      };
    }
    return { ok: true, dataUrl };
  } catch {
    return {
      ok: false,
      error: { code: 'DECODE_FAILED', message: i18n.t('featMgmt:uploadLogo.decodeFailed') },
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function useUploadLogo() {
  const update = useMutationUpdateReceiptSettings();

  async function apply(current: ReceiptSettings, logoDataUrl: string | null) {
    const next: ReceiptSettings = { ...current, logoDataUrl };
    return update.mutateAsync(next);
  }

  return {
    apply,
    isPending: update.isPending,
  };
}
