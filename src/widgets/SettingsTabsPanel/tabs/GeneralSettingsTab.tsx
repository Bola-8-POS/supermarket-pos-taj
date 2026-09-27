import { ImageOff, ImagePlus, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ACCEPTED_LOGO_MIME_TYPES,
  useMutationUpdateSetting,
  useRemoveStoreLogo,
  useSettings,
  useStoreLogoUpload,
  useStoreLogoUrl,
} from '@entities/settings';
import type { UserRole } from '@shared/lib/domain';
import type { AppError } from '@shared/lib/result';
import { cn } from '@shared/lib/utils';
import { ConfirmDialog, Input, Label, LoadingSpinner, POSButton, ProtectedAction, Skeleton } from '@shared/ui';
import { useRegisterUnsavedChanges } from '../model/unsaved-changes';

type Props = {
  currentRole: UserRole | null;
};

type GeneralForm = {
  storeName: string;
  address: string;
  timezone: string;
  currency: string;
  receiptFooterText: string;
  storeLogoPath: string | null;
};

const DEFAULT_FORM: GeneralForm = {
  storeName: '',
  address: '',
  timezone: 'America/Mexico_City',
  currency: 'MXN',
  receiptFooterText: '',
  storeLogoPath: null,
};

const ACCEPT_ATTR = ACCEPTED_LOGO_MIME_TYPES.join(',');

/**
 * Returns the first image entry in a drag-and-drop item list — including one
 * whose type is unsupported, so validateStoreLogoFile can name the offending
 * type in its error rather than the drop being silently ignored. Mirrors
 * ProductPhotoTab's firstImageFromDataTransfer (33-PLAN.md Task 1).
 */
function firstImageFromDataTransfer(items: DataTransferItemList | null | undefined): File | null {
  if (!items) return null;
  for (const item of Array.from(items)) {
    // eslint-disable-next-line i18next/no-literal-string -- MIME-type prefix literal, not UI copy
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export function GeneralSettingsTab({ currentRole }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data } = useSettings();
  const updateSetting = useMutationUpdateSetting();
  const uploadMutation = useStoreLogoUpload();
  const removeMutation = useRemoveStoreLogo();
  const [form, setForm] = useState<GeneralForm>(DEFAULT_FORM);
  const [dirty, setDirty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [logoStage, setLogoStage] = useState<'idle' | 'processing' | 'uploading'>('idle');
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  const { url: logoUrl, isLoading: isSigningLogo } = useStoreLogoUrl(form.storeLogoPath);
  const logoInFlight = uploadMutation.isPending || removeMutation.isPending;
  const logoDisabled = logoInFlight;
  const hasLogo = form.storeLogoPath != null;

  useEffect(() => {
    if (!data || dirty) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setForm({
      storeName: data.general.storeName,
      address: data.general.address,
      timezone: data.general.timezone,
      currency: data.general.currency,
      receiptFooterText: data.general.receiptFooterText,
      storeLogoPath: data.general.storeLogoPath,
    });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data, dirty]);

  const save = useCallback(async (): Promise<boolean> => {
    const result = await updateSetting.mutateAsync({
      key: 'general',
      value: {
        storeName: form.storeName.trim(),
        address: form.address.trim(),
        timezone: form.timezone.trim(),
        currency: form.currency.trim().toUpperCase(),
        receiptFooterText: form.receiptFooterText.trim(),
        storeLogoPath: form.storeLogoPath,
      },
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return false;
    }
    setDirty(false);
    toast.success(t('generalSettingsTab.saved'));
    return true;
  }, [form, updateSetting, t]);

  useRegisterUnsavedChanges(dirty, save);

  function logoErrorCopyFor(error: AppError): string {
    switch (error.code) {
      case 'VALIDATION_ERROR':
        return t('generalSettingsTab.logoErrorUnsupportedType', { type: error.detail ?? '' });
      case 'PHOTO_TOO_LARGE':
        return t('generalSettingsTab.logoErrorTooLarge', { size: error.detail ?? '' });
      case 'PHOTO_DECODE_FAILED':
        return t('generalSettingsTab.logoErrorDecode', { type: error.detail ?? '' });
      case 'PHOTO_UPLOAD_FAILED':
        // WR-03: error.message is developer/log-facing text (English, not
        // run through i18n) -- never surface it verbatim to the admin.
        return t('generalSettingsTab.logoErrorUpload');
      case 'PHOTO_LINK_FAILED':
        return t('generalSettingsTab.logoErrorLink');
      case 'PHOTO_REMOVE_FAILED':
        return t('generalSettingsTab.logoErrorRemove');
      case 'NETWORK_OFFLINE':
        return t('generalSettingsTab.logoErrorOffline');
      default:
        // WR-03: error.message is developer/log-facing text (English, not
        // run through i18n) -- never surface it verbatim to the admin.
        return t('generalSettingsTab.logoErrorGeneric');
    }
  }

  function openLogoPicker(): void {
    if (logoDisabled) return;
    fileInputRef.current?.click();
  }

  function handleLogoKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openLogoPicker();
    }
  }

  function handleLogoFile(file: File): void {
    if (logoDisabled) return;
    setLogoError(null);
    setImgFailed(false);
    uploadMutation.mutate(
      { previousPath: form.storeLogoPath, file, onStageChange: setLogoStage },
      {
        onSuccess: result => {
          if (!result.ok) {
            const message = logoErrorCopyFor(result.error);
            setLogoError(message);
            toast.error(message);
            return;
          }
          setForm(current => ({ ...current, storeLogoPath: result.data.path }));
          toast.success(t('generalSettingsTab.logoUploaded'));
        },
        onSettled: () => {
          setLogoStage('idle');
        },
      }
    );
  }

  function handleLogoFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    handleLogoFile(file);
  }

  function handleLogoDragOver(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    if (logoDisabled) return;
    setIsDragOver(true);
  }

  function handleLogoDragLeave(): void {
    setIsDragOver(false);
  }

  function handleLogoDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setIsDragOver(false);
    if (logoDisabled) return;
    const file = firstImageFromDataTransfer(e.dataTransfer.items);
    if (file) handleLogoFile(file);
  }

  function handleLogoRemoveConfirm(): void {
    if (!form.storeLogoPath) return;
    removeMutation.mutate(
      { path: form.storeLogoPath },
      {
        onSuccess: result => {
          setRemoveConfirmOpen(false);
          if (!result.ok) {
            const message = logoErrorCopyFor(result.error);
            setLogoError(message);
            toast.error(message);
            return;
          }
          setLogoError(null);
          setImgFailed(false);
          setForm(current => ({ ...current, storeLogoPath: null }));
          toast.success(t('generalSettingsTab.logoRemoved'));
        },
      }
    );
  }

  return (
    <ProtectedAction
      action="manage_settings"
      currentRole={currentRole}
      disabled={updateSetting.isPending}
    >
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('generalSettingsTab.title')}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="settings-store-name">{t('generalSettingsTab.storeNameLabel')}</Label>
            <Input
              id="settings-store-name"
              value={form.storeName}
              onChange={event => {
                setDirty(true);
                setForm(current => ({ ...current, storeName: event.target.value }));
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-currency">{t('generalSettingsTab.currencyLabel')}</Label>
            <Input
              id="settings-currency"
              value={form.currency}
              maxLength={3}
              onChange={event => {
                setDirty(true);
                setForm(current => ({ ...current, currency: event.target.value }));
              }}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>{t('generalSettingsTab.logoLabel')}</Label>
            <div className="flex flex-wrap items-center gap-4">
              {isSigningLogo && hasLogo ? (
                <Skeleton className="size-20 rounded-xl" />
              ) : (
                <div
                  data-testid="settings-store-logo-dropzone"
                  role="button"
                  tabIndex={0}
                  aria-label={t('generalSettingsTab.logoChooseFile')}
                  onClick={openLogoPicker}
                  onKeyDown={handleLogoKeyDown}
                  onDragOver={handleLogoDragOver}
                  onDragLeave={handleLogoDragLeave}
                  onDrop={handleLogoDrop}
                  className={cn(
                    'relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl p-2 transition-colors duration-150',
                    isDragOver
                      ? 'border-2 border-brand bg-brand-soft/80'
                      : hasLogo
                        ? 'border border-border bg-card'
                        : 'border-2 border-dashed border-border-strong bg-muted',
                    logoDisabled && 'pointer-events-none opacity-70'
                  )}
                >
                  {isDragOver && (
                    <span className="sr-only">{t('generalSettingsTab.logoDropHere')}</span>
                  )}
                  {hasLogo ? (
                    imgFailed ? (
                      <ImageOff className="size-5 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <img
                        data-testid="settings-store-logo-preview"
                        src={logoUrl ?? undefined}
                        alt={t('generalSettingsTab.logoLabel')}
                        className="max-h-full max-w-full object-contain"
                        onError={() => {
                          setImgFailed(true);
                          const message = t('generalSettingsTab.logoErrorLoad');
                          setLogoError(message);
                          toast.error(message);
                        }}
                      />
                    )
                  ) : (
                    <ImagePlus className="size-6 text-muted-foreground" aria-hidden="true" />
                  )}

                  {logoInFlight && (
                    <div className="absolute inset-0 flex items-center justify-center bg-popover/70">
                      <LoadingSpinner />
                    </div>
                  )}

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPT_ATTR}
                    data-testid="settings-store-logo-file-input"
                    className="sr-only"
                    onChange={handleLogoFileChange}
                    disabled={logoDisabled}
                  />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <POSButton
                    type="button"
                    variant="outline"
                    touchSize="default"
                    disabled={logoDisabled}
                    onClick={openLogoPicker}
                    data-testid={hasLogo ? 'settings-store-logo-replace' : undefined}
                  >
                    {hasLogo && <Upload className="size-4" aria-hidden="true" />}
                    {t(hasLogo ? 'generalSettingsTab.logoReplace' : 'generalSettingsTab.logoChooseFile')}
                  </POSButton>
                  {hasLogo && (
                    <POSButton
                      type="button"
                      variant="destructive"
                      touchSize="default"
                      disabled={logoDisabled}
                      onClick={() => {
                        setRemoveConfirmOpen(true);
                      }}
                      data-testid="settings-store-logo-remove"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      {t('generalSettingsTab.logoRemove')}
                    </POSButton>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {logoStage === 'processing'
                    ? t('generalSettingsTab.logoProcessing')
                    : logoStage === 'uploading'
                      ? t('generalSettingsTab.logoUploading')
                      : t('generalSettingsTab.logoHint')}
                </p>
                {logoError && (
                  <p role="alert" className="text-sm text-destructive">
                    {logoError}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="settings-address">{t('generalSettingsTab.addressLabel')}</Label>
            <Input
              id="settings-address"
              value={form.address}
              onChange={event => {
                setDirty(true);
                setForm(current => ({ ...current, address: event.target.value }));
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-timezone">{t('generalSettingsTab.timezoneLabel')}</Label>
            <Input
              id="settings-timezone"
              value={form.timezone}
              onChange={event => {
                setDirty(true);
                setForm(current => ({ ...current, timezone: event.target.value }));
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-receipt-footer">
              {t('generalSettingsTab.receiptFooterLabel')}
            </Label>
            <Input
              id="settings-receipt-footer"
              value={form.receiptFooterText}
              onChange={event => {
                setDirty(true);
                setForm(current => ({ ...current, receiptFooterText: event.target.value }));
              }}
            />
          </div>
        </div>
        <POSButton
          type="button"
          touchSize="large"
          disabled={!dirty || updateSetting.isPending}
          onClick={() => {
            void save();
          }}
        >
          {updateSetting.isPending ? t('generalSettingsTab.saving') : t('generalSettingsTab.saveGeneral')}
        </POSButton>
      </div>

      <ConfirmDialog
        open={removeConfirmOpen}
        title={t('generalSettingsTab.logoRemoveConfirmTitle')}
        description={t('generalSettingsTab.logoRemoveConfirmDescription')}
        confirmLabel={t('generalSettingsTab.logoRemoveConfirmLabel')}
        cancelLabel={t('generalSettingsTab.logoRemoveConfirmCancelLabel')}
        variant="destructive"
        isLoading={removeMutation.isPending}
        onConfirm={handleLogoRemoveConfirm}
        onCancel={() => {
          setRemoveConfirmOpen(false);
        }}
      />
    </ProtectedAction>
  );
}
