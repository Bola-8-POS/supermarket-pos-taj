import { Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useModifiers,
  useMutationCreateModifier,
  useMutationDeleteModifier,
  useMutationUpdateModifier,
} from '@entities/product';
import type { Modifier } from '@shared/lib/domain';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';
import { FormField } from '@shared/ui/FormField';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { MoneyInput } from '@shared/ui/MoneyInput';
import { POSButton } from '@shared/ui/POSButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';

export function CatalogModifiersTab() {
  const { t } = useTranslation('featMgmt');
  const { data: modifiers, isLoading, resultError } = useModifiers();
  const createMutation = useMutationCreateModifier();
  const updateMutation = useMutationUpdateModifier();
  const deleteMutation = useMutationDeleteModifier();

  const [createOpen, setCreateOpen] = useState(false);
  const [editModifier, setEditModifier] = useState<Modifier | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...(modifiers ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
      ),
    [modifiers]
  );

  const nextSortOrder = useMemo(() => {
    if (!sorted.length) return 0;
    return Math.max(...sorted.map(m => m.sortOrder)) + 1;
  }, [sorted]);

  if (resultError) {
    return (
      <p className="text-destructive text-sm">
        {t('manageProducts.modifiersTab.loadError', { message: resultError.message })}
      </p>
    );
  }

  if (isLoading) {
    return (
      <p className="text-muted-foreground text-sm">{t('manageProducts.modifiersTab.loading')}</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {t('manageProducts.modifiersTab.headerHelp')}
        </p>
        <POSButton
          type="button"
          touchSize="default"
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          {t('manageProducts.modifiersTab.addModifier')}
        </POSButton>
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {sorted.map(m => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
            <div>
              <p className="font-medium">{m.name}</p>
              <p className="text-muted-foreground text-sm">
                {t('manageProducts.modifiersTab.priceDeltaLabel')}{' '}
                <MoneyDisplay amount={m.priceDelta} />{' '}
                {t('manageProducts.modifiersTab.sortLabel', { sortOrder: m.sortOrder })}
              </p>
            </div>
            <div className="flex gap-1">
              <POSButton
                type="button"
                variant="outline"
                touchSize="default"
                size="icon"
                onClick={() => {
                  setEditModifier(m);
                }}
              >
                <Pencil className="size-4" />
                <span className="sr-only">{t('manageProducts.modifiersTab.edit')}</span>
              </POSButton>
              <POSButton
                type="button"
                variant="outline"
                touchSize="default"
                size="icon"
                onClick={() => {
                  setDeleteId(m.id);
                }}
              >
                <Trash2 className="size-4" />
                <span className="sr-only">{t('manageProducts.modifiersTab.delete')}</span>
              </POSButton>
            </div>
          </li>
        ))}
      </ul>

      <ModifierDialog
        title={t('manageProducts.modifiersTab.newModifierTitle')}
        open={createOpen}
        onOpenChange={setCreateOpen}
        submitting={createMutation.isPending}
        initial={null}
        defaultSortOrder={nextSortOrder}
        onSave={async (name, priceDelta, sortOrder) => {
          const r = await createMutation.mutateAsync({ name, priceDelta, sortOrder });
          if (!r.ok) toast.error(r.error.message);
          else {
            toast.success(t('manageProducts.modifiersTab.modifierCreated'));
            setCreateOpen(false);
          }
        }}
      />

      <ModifierDialog
        title={t('manageProducts.modifiersTab.editModifierTitle')}
        open={editModifier != null}
        onOpenChange={o => {
          if (!o) setEditModifier(null);
        }}
        submitting={updateMutation.isPending}
        initial={editModifier}
        defaultSortOrder={nextSortOrder}
        onSave={async (name, priceDelta, sortOrder) => {
          if (!editModifier) return;
          const r = await updateMutation.mutateAsync({
            id: editModifier.id,
            name,
            priceDelta,
            sortOrder,
          });
          if (!r.ok) toast.error(r.error.message);
          else {
            toast.success(t('manageProducts.modifiersTab.modifierSaved'));
            setEditModifier(null);
          }
        }}
      />

      <ConfirmDialog
        open={deleteId != null}
        title={t('manageProducts.modifiersTab.deleteModifierTitle')}
        description={t('manageProducts.modifiersTab.deleteModifierDescription')}
        confirmLabel={t('manageProducts.modifiersTab.deleteModifierConfirmLabel')}
        variant="destructive"
        isLoading={deleteMutation.isPending}
        onConfirm={async () => {
          if (deleteId == null) return;
          const id = deleteId;
          const r = await deleteMutation.mutateAsync(id);
          setDeleteId(null);
          if (!r.ok) toast.error(r.error.message);
          else toast.success(t('manageProducts.modifiersTab.modifierDeleted'));
        }}
        onCancel={() => {
          setDeleteId(null);
        }}
      />
    </div>
  );
}

function ModifierDialog({
  title,
  open,
  onOpenChange,
  submitting,
  initial,
  defaultSortOrder,
  onSave,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  initial: Modifier | null;
  defaultSortOrder: number;
  onSave: (name: string, priceDelta: number, sortOrder: number) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {open ? (
          <ModifierDialogForm
            key={`${initial?.id ?? 'new'}-${String(defaultSortOrder)}`}
            submitting={submitting}
            initial={initial}
            defaultSortOrder={defaultSortOrder}
            onSave={onSave}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ModifierDialogForm({
  submitting,
  initial,
  defaultSortOrder,
  onSave,
  onOpenChange,
}: {
  submitting: boolean;
  initial: Modifier | null;
  defaultSortOrder: number;
  onSave: (name: string, priceDelta: number, sortOrder: number) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('featMgmt');
  const [name, setName] = useState(initial?.name ?? '');
  const [priceDelta, setPriceDelta] = useState(initial?.priceDelta ?? 0);
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? defaultSortOrder));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={e => {
        e.preventDefault();
        const so = Number.parseInt(sortOrder, 10);
        if (name.trim() === '') {
          toast.error(t('manageProducts.modifiersTab.nameRequired'));
          return;
        }
        if (Number.isNaN(so) || so < 0) {
          toast.error(t('manageProducts.modifiersTab.sortOrderInvalid'));
          return;
        }
        void onSave(name.trim(), priceDelta, so);
      }}
    >
      <FormField label={t('manageProducts.modifiersTab.nameLabel')} required error="">
        <Input
          value={name}
          onChange={e => {
            setName(e.target.value);
          }}
          disabled={submitting}
        />
      </FormField>
      <FormField
        label={t('manageProducts.modifiersTab.priceDeltaLabel')}
        hint={t('manageProducts.modifiersTab.priceDeltaHint')}
        error=""
      >
        <MoneyInput value={priceDelta} onChange={setPriceDelta} disabled={submitting} />
      </FormField>
      <FormField label={t('manageProducts.modifiersTab.sortOrderLabel')} required error="">
        <Input
          inputMode="numeric"
          value={sortOrder}
          onChange={e => {
            setSortOrder(e.target.value);
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
