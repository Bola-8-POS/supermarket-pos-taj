import { Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useBrands,
  useMutationCreateBrand,
  useMutationDeleteBrand,
  useMutationUpdateBrand,
} from '@entities/brand';
import type { Brand } from '@shared/lib/domain';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';
import { FormField } from '@shared/ui/FormField';
import { POSButton } from '@shared/ui/POSButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';

export function CatalogBrandsTab() {
  const { t } = useTranslation('featMgmt');
  const { data: brands, isLoading, resultError } = useBrands();
  const createMutation = useMutationCreateBrand();
  const updateMutation = useMutationUpdateBrand();
  const deleteMutation = useMutationDeleteBrand();

  const [createOpen, setCreateOpen] = useState(false);
  const [editBrand, setEditBrand] = useState<Brand | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...(brands ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [brands]
  );

  if (resultError) {
    return (
      <p className="text-destructive text-sm">
        {t('manageProducts.brandsTab.loadError', { message: resultError.message })}
      </p>
    );
  }

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">{t('manageProducts.brandsTab.loading')}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <p className="text-muted-foreground text-sm">{t('manageProducts.brandsTab.headerHelp')}</p>
        <POSButton
          type="button"
          touchSize="default"
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          {t('manageProducts.brandsTab.addBrand')}
        </POSButton>
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {sorted.map(b => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
            <p className="font-medium">{b.name}</p>
            <div className="flex gap-1">
              <POSButton
                type="button"
                variant="outline"
                touchSize="default"
                size="icon"
                onClick={() => {
                  setEditBrand(b);
                }}
              >
                <Pencil className="size-4" />
                <span className="sr-only">{t('manageProducts.brandsTab.edit')}</span>
              </POSButton>
              <POSButton
                type="button"
                variant="outline"
                touchSize="default"
                size="icon"
                onClick={() => {
                  setDeleteId(b.id);
                }}
              >
                <Trash2 className="size-4" />
                <span className="sr-only">{t('manageProducts.brandsTab.delete')}</span>
              </POSButton>
            </div>
          </li>
        ))}
      </ul>

      <BrandDialog
        title={t('manageProducts.brandsTab.newBrandTitle')}
        open={createOpen}
        onOpenChange={setCreateOpen}
        submitting={createMutation.isPending}
        initial={null}
        onSave={async name => {
          const r = await createMutation.mutateAsync({ name });
          if (!r.ok) toast.error(r.error.message);
          else {
            toast.success(t('manageProducts.brandsTab.brandCreated'));
            setCreateOpen(false);
          }
        }}
      />

      <BrandDialog
        title={t('manageProducts.brandsTab.editBrandTitle')}
        open={editBrand != null}
        onOpenChange={o => {
          if (!o) setEditBrand(null);
        }}
        submitting={updateMutation.isPending}
        initial={editBrand}
        onSave={async name => {
          if (!editBrand) return;
          const r = await updateMutation.mutateAsync({ id: editBrand.id, name });
          if (!r.ok) toast.error(r.error.message);
          else {
            toast.success(t('manageProducts.brandsTab.brandSaved'));
            setEditBrand(null);
          }
        }}
      />

      <ConfirmDialog
        open={deleteId != null}
        title={t('manageProducts.brandsTab.deleteBrandTitle')}
        description={t('manageProducts.brandsTab.deleteBrandDescription')}
        confirmLabel={t('manageProducts.brandsTab.deleteBrandConfirmLabel')}
        variant="destructive"
        isLoading={deleteMutation.isPending}
        onConfirm={async () => {
          if (deleteId == null) return;
          const id = deleteId;
          const r = await deleteMutation.mutateAsync(id);
          setDeleteId(null);
          if (!r.ok) toast.error(r.error.message);
          else toast.success(t('manageProducts.brandsTab.brandDeleted'));
        }}
        onCancel={() => {
          setDeleteId(null);
        }}
      />
    </div>
  );
}

function BrandDialog({
  title,
  open,
  onOpenChange,
  submitting,
  initial,
  onSave,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  initial: Brand | null;
  onSave: (name: string) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {open ? (
          <BrandDialogForm
            key={initial?.id ?? 'new'}
            submitting={submitting}
            initial={initial}
            onSave={onSave}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BrandDialogForm({
  submitting,
  initial,
  onSave,
  onOpenChange,
}: {
  submitting: boolean;
  initial: Brand | null;
  onSave: (name: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('featMgmt');
  const [name, setName] = useState(initial?.name ?? '');

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={e => {
        e.preventDefault();
        if (name.trim() === '') {
          toast.error(t('manageProducts.brandsTab.nameRequired'));
          return;
        }
        void onSave(name.trim());
      }}
    >
      <FormField label={t('manageProducts.brandsTab.nameLabel')} required error="">
        <Input
          value={name}
          onChange={e => {
            setName(e.target.value);
          }}
          disabled={submitting}
        />
      </FormField>
      <div className="flex justify-end gap-2 border-t pt-4">
        <POSButton
          type="button"
          variant="outline"
          touchSize="default"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('common:actions.cancel')}
        </POSButton>
        <POSButton type="submit" touchSize="default" disabled={submitting}>
          {submitting ? t('common:actions.saving') : t('common:actions.save')}
        </POSButton>
      </div>
    </form>
  );
}
