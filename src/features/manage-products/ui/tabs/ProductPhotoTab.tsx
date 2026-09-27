/**
 * Photo panel mounted in the product edit dialog (Phase 31). Wires all three
 * D-09 entry paths — OS file picker, drag-and-drop, and clipboard paste (via
 * the imperative handle `handleFile`, called by `ProductDetailDialog`'s
 * tab-scoped paste listener) — onto the single validate -> resize -> upload
 * -> link pipeline, plus a confirmed Remove (D-12) and the full loading/error
 * state matrix from 31-UI-SPEC.md's Photo tab table.
 */
import { ImageOff, ImagePlus, Trash2, Upload } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useProductImageUrl } from '@entities/product';
import type { Product } from '@shared/lib/domain';
import type { AppError } from '@shared/lib/result';
import { cn } from '@shared/lib/utils';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';
import { EmptyState } from '@shared/ui/EmptyState';
import { LoadingSpinner } from '@shared/ui/LoadingSpinner';
import { POSButton } from '@shared/ui/POSButton';
import { Skeleton } from '@shared/ui/skeleton';
import { ACCEPTED_PHOTO_MIME_TYPES, firstImageFromDataTransfer } from '../../model/photo-file';
import { useProductPhotoUpload, useRemoveProductPhoto } from '../../model/useProductPhotoUpload';

export type ProductPhotoTabProps = {
  product: Product;
  submitting: boolean;
};

/** Imperative handle so the dialog-level paste listener (Photo-tab-scoped) can feed a pasted file into this panel's own pipeline without duplicating the upload logic. */
export type ProductPhotoTabHandle = {
  handleFile: (file: File) => void;
};

const ACCEPT_ATTR = ACCEPTED_PHOTO_MIME_TYPES.join(',');

export const ProductPhotoTab = forwardRef<ProductPhotoTabHandle, ProductPhotoTabProps>(
  function ProductPhotoTab({ product, submitting }, ref) {
  const { t } = useTranslation('featMgmt');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [stage, setStage] = useState<'idle' | 'processing' | 'uploading'>('idle');
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  // CatalogProductsTab's `editProduct` is a plain useState set once when the
  // dialog opens — it is never resynced after invalidateCatalogQueries
  // refetches the catalog, so `product.photoPath` stays stale for the whole
  // dialog session. Track the just-uploaded path locally so the preview
  // updates immediately without depending on the parent re-passing a fresh
  // product object.
  const [localPhotoPath, setLocalPhotoPath] = useState<string | null>(product.photoPath);
  const uploadMutation = useProductPhotoUpload();
  const removeMutation = useRemoveProductPhoto();
  const { url, isLoading: isSigning } = useProductImageUrl({ ...product, photoPath: localPhotoPath });

  const disabled = submitting || uploadMutation.isPending || removeMutation.isPending;
  const isInFlight = uploadMutation.isPending || removeMutation.isPending;

  function errorCopyFor(error: AppError): string {
    const unknownTypeLabel = t('manageProducts.productDialog.photo.unknownType');
    switch (error.code) {
      case 'VALIDATION_ERROR':
        return t('manageProducts.productDialog.photo.errorUnsupportedType', {
          type: error.detail === 'unknownType' || !error.detail ? unknownTypeLabel : error.detail,
        });
      case 'PHOTO_TOO_LARGE':
        return t('manageProducts.productDialog.photo.errorTooLarge', { size: error.detail ?? '' });
      case 'PHOTO_DECODE_FAILED':
        return t('manageProducts.productDialog.photo.errorDecode', {
          type: error.detail === 'unknownType' || !error.detail ? unknownTypeLabel : error.detail,
        });
      case 'PHOTO_UPLOAD_FAILED':
        return t('manageProducts.productDialog.photo.errorUpload', { message: error.message });
      case 'PHOTO_LINK_FAILED':
        return t('manageProducts.productDialog.photo.errorLink');
      case 'PHOTO_REMOVE_FAILED':
        return t('manageProducts.productDialog.photo.errorRemove', { message: error.message });
      case 'NETWORK_OFFLINE':
        return t('manageProducts.productDialog.photo.errorOffline');
      default:
        return error.message;
    }
  }

  function openPicker(): void {
    if (disabled) return;
    fileInputRef.current?.click();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  }

  function handleFile(file: File): void {
    if (disabled) return;
    setErrorMessage(null);
    setImgFailed(false);
    uploadMutation.mutate(
      { productId: product.id, previousPath: localPhotoPath, file, onStageChange: setStage },
      {
        onSuccess: result => {
          if (!result.ok) {
            const message = errorCopyFor(result.error);
            setErrorMessage(message);
            toast.error(message);
            return;
          }
          setLocalPhotoPath(result.data.path);
          toast.success(t('manageProducts.productDialog.photo.uploaded'));
        },
        onSettled: () => {
          setStage('idle');
        },
      }
    );
  }

  function handleRemoveConfirm(): void {
    if (!localPhotoPath) return;
    removeMutation.mutate(
      { productId: product.id, path: localPhotoPath },
      {
        onSuccess: result => {
          setRemoveConfirmOpen(false);
          if (!result.ok) {
            const message = errorCopyFor(result.error);
            setErrorMessage(message);
            toast.error(message);
            return;
          }
          setErrorMessage(null);
          setLocalPhotoPath(null);
          toast.success(t('manageProducts.productDialog.photo.removed'));
        },
      }
    );
  }

  useImperativeHandle(ref, () => ({ handleFile }));

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    handleFile(file);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    if (disabled) return;
    setIsDragOver(true);
  }

  function handleDragLeave(): void {
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled) return;
    // Deliberate divergence from agent-chat/FileDropZone (D-09/D-11): an
    // unsupported image type is still extracted here so validatePhotoFile
    // (inside the upload pipeline) can name the offending type in a visible
    // error, rather than the analog's silent log-only drop.
    const file = firstImageFromDataTransfer(e.dataTransfer.items);
    if (file) handleFile(file);
  }

  const hasPhoto = localPhotoPath != null;

  return (
    <>
    <div className="flex flex-col items-center gap-4">
      <div
        data-testid="product-photo-dropzone"
        className={cn(
          'relative aspect-square w-full max-w-[20rem] overflow-hidden rounded-xl transition-colors duration-150',
          isDragOver
            ? 'border-2 border-brand bg-brand-soft/80'
            : hasPhoto
              ? 'border border-border bg-muted'
              : 'border-2 border-dashed border-border-strong bg-card',
          disabled && 'pointer-events-none opacity-70'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        {...(hasPhoto
          ? {}
          : {
              role: 'button' as const,
              tabIndex: 0,
              onClick: openPicker,
              onKeyDown: handleKeyDown,
              'aria-label': t('manageProducts.productDialog.photo.chooseFile'),
            })}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="text-sm font-semibold text-brand-strong">
              {t('manageProducts.productDialog.photo.dropHere')}
            </span>
          </div>
        )}
        {hasPhoto ? (
          isSigning || !url ? (
            <Skeleton className="size-full rounded-xl" />
          ) : imgFailed ? (
            <div className="flex size-full flex-col items-center justify-center gap-2">
              <ImageOff className="size-10 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">
                {t('manageProducts.productDialog.photo.errorLoad')}
              </span>
            </div>
          ) : (
            <img
              data-testid="product-photo-preview"
              src={url}
              alt={t('manageProducts.productDialog.photo.altText', { name: product.name })}
              className="size-full object-contain p-4"
              onError={() => {
                setImgFailed(true);
              }}
            />
          )
        ) : (
          <EmptyState
            className="[&_h3]:text-lg"
            icon={ImagePlus}
            title={t('manageProducts.productDialog.photo.emptyTitle')}
            description={t('manageProducts.productDialog.photo.emptyBody')}
            action={{ label: t('manageProducts.productDialog.photo.chooseFile'), onClick: openPicker }}
          />
        )}

        {isInFlight && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-popover/70">
            <LoadingSpinner />
            <span className="text-sm text-muted-foreground">
              {stage === 'processing'
                ? t('manageProducts.productDialog.photo.processing')
                : t('manageProducts.productDialog.photo.uploading')}
            </span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          data-testid="product-photo-file-input"
          className="sr-only"
          onChange={handleFileChange}
          disabled={disabled}
        />
      </div>

      {hasPhoto && (
        <div className="flex flex-wrap justify-center gap-4">
          <POSButton
            type="button"
            variant="outline"
            touchSize="default"
            disabled={disabled}
            onClick={openPicker}
            data-testid="product-photo-replace"
          >
            <Upload className="size-4" aria-hidden="true" />
            {t('manageProducts.productDialog.photo.replace')}
          </POSButton>
          <POSButton
            type="button"
            variant="destructive"
            touchSize="default"
            disabled={disabled}
            onClick={() => {
              setRemoveConfirmOpen(true);
            }}
            data-testid="product-photo-remove"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {t('manageProducts.productDialog.photo.remove')}
          </POSButton>
        </div>
      )}

      {!hasPhoto && (
        <p className="text-sm text-muted-foreground">
          {t('manageProducts.productDialog.photo.formatsHint')}
        </p>
      )}

      {errorMessage && (
        <p role="alert" className="text-sm text-destructive text-center max-w-[20rem]">
          {errorMessage}
        </p>
      )}
    </div>

    <ConfirmDialog
      open={removeConfirmOpen}
      title={t('manageProducts.productDialog.photo.removeConfirmTitle')}
      description={t('manageProducts.productDialog.photo.removeConfirmDescription')}
      confirmLabel={t('manageProducts.productDialog.photo.removeConfirmLabel')}
      cancelLabel={t('manageProducts.productDialog.photo.removeConfirmCancelLabel')}
      variant="destructive"
      isLoading={removeMutation.isPending}
      onConfirm={handleRemoveConfirm}
      onCancel={() => {
        setRemoveConfirmOpen(false);
      }}
    />
    </>
  );
  }
);
