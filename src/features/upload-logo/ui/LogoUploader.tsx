import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ReceiptSettings } from '@entities/settings';
import { logger } from '@shared/lib/logger-instance';
import { Button } from '@shared/ui/button';
import { Label } from '@shared/ui/label';
import { encodeLogoDataUrl, useUploadLogo } from '../model/useUploadLogo';

type Props = {
  receipt: ReceiptSettings;
};

export function LogoUploader({ receipt }: Props) {
  const { t } = useTranslation('featMgmt');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { apply, isPending } = useUploadLogo();
  const [processing, setProcessing] = useState(false);

  const busy = isPending || processing;
  const hasLogo = receipt.logoDataUrl !== null && receipt.logoDataUrl.length > 0;

  async function onFileSelected(file: File) {
    setProcessing(true);
    const encoded = await encodeLogoDataUrl(file);
    setProcessing(false);
    if (!encoded.ok) {
      toast.error(encoded.error.message);
      return;
    }
    const result = await apply(receipt, encoded.dataUrl);
    if (!result.ok) {
      logger.error('upload_logo.failed', {
        code: result.error.code,
        message: result.error.message,
      });
      toast.error(result.error.message);
      return;
    }
    toast.success(t('uploadLogo.updatedToast'));
    if (inputRef.current) inputRef.current.value = '';
  }

  async function onRemove() {
    const result = await apply(receipt, null);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(t('uploadLogo.removedToast'));
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
      <h3 className="font-medium">{t('uploadLogo.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('uploadLogo.description')}</p>

      <div className="flex items-start gap-4">
        <div
          data-testid="logo-uploader-preview"
          className="flex size-20 items-center justify-center overflow-hidden rounded border bg-muted"
        >
          {hasLogo ? (
            <img
              src={receipt.logoDataUrl ?? ''}
              alt={t('uploadLogo.currentLogoAlt')}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-xs text-muted-foreground">{t('uploadLogo.noLogo')}</span>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="logo-upload-input">{t('uploadLogo.logoFileLabel')}</Label>
          <input
            ref={inputRef}
            id="logo-upload-input"
            data-testid="logo-uploader-input"
            type="file"
            accept="image/png,image/jpeg"
            disabled={busy}
            onChange={e => {
              const file = e.target.files?.[0];
              if (!file) return;
              void onFileSelected(file);
            }}
            className="block text-sm"
          />
          {hasLogo ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void onRemove();
              }}
            >
              {t('uploadLogo.removeLogo')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
