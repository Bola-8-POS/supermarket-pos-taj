import type { ColumnDef } from '@tanstack/react-table';
import { Pencil, Plus, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SupplierForm } from '@features/manage-suppliers';
import { useProductsForManagement } from '@entities/product';
import {
  useMutationCreateSupplier,
  useMutationDeleteSupplier,
  useMutationUpdateSupplier,
  useSuppliers,
  type Supplier,
} from '@entities/supplier';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';
import { DataTable } from '@shared/ui/DataTable';
import { EmptyState } from '@shared/ui/EmptyState';
import { POSButton } from '@shared/ui/POSButton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';

type DialogState = { open: boolean; supplier: Supplier | null };

export function SupplierListPanel() {
  const { t } = useTranslation('wAdmin');
  const { data: suppliers, isLoading, resultError } = useSuppliers();
  const { data: products } = useProductsForManagement();
  const create = useMutationCreateSupplier();
  const update = useMutationUpdateSupplier();
  const remove = useMutationDeleteSupplier();
  const [dialog, setDialog] = useState<DialogState>({ open: false, supplier: null });
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const openCreate = () => {
    setDialog({ open: true, supplier: null });
  };
  const openEdit = (supplier: Supplier) => {
    setDialog({ open: true, supplier });
  };
  const close = () => {
    setDialog(d => ({ ...d, open: false }));
  };
  const isEdit = dialog.supplier != null;

  const columns: ColumnDef<Supplier>[] = [
    {
      id: 'name',
      accessorFn: s => s.name,
      header: t('supplierListPanel.columnName'),
      cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
    },
    {
      id: 'contact',
      accessorFn: s => [s.contactName, s.phone].filter(Boolean).join(' '),
      header: t('supplierListPanel.columnContact'),
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          {row.original.contactName ? (
            <span className="truncate">{row.original.contactName}</span>
          ) : null}
          {row.original.phone ? (
            <span className="truncate text-xs text-muted-foreground text-numeric">
              {row.original.phone}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'email',
      accessorFn: s => s.email ?? '',
      header: t('supplierListPanel.columnEmail'),
      cell: info => (
        <span className="truncate text-muted-foreground">{info.getValue<string>()}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <POSButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('supplierListPanel.edit')}
            onClick={e => {
              e.stopPropagation();
              openEdit(row.original);
            }}
          >
            <Pencil className="size-4" />
          </POSButton>
          <POSButton
            type="button"
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive"
            aria-label={t('supplierListPanel.delete')}
            onClick={e => {
              e.stopPropagation();
              setDeleteId(row.original.id);
            }}
          >
            <Trash2 className="size-4" />
          </POSButton>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-4">
      {resultError ? (
        <p className="text-sm text-destructive" role="alert">
          {resultError.message}
        </p>
      ) : null}
      <DataTable
        columns={columns}
        data={suppliers ?? []}
        isLoading={isLoading}
        searchable
        searchPlaceholder={t('supplierListPanel.search')}
        onRowClick={openEdit}
        toolbar={
          <POSButton type="button" variant="brand" className="ml-auto" onClick={openCreate}>
            <Plus className="size-4" />
            {t('supplierListPanel.newSupplier')}
          </POSButton>
        }
        emptyState={
          <EmptyState
            icon={Truck}
            title={t('supplierListPanel.emptyTitle')}
            description={t('supplierListPanel.emptyBody')}
            action={{ label: t('supplierListPanel.addSupplier'), onClick: openCreate }}
          />
        }
      />

      <Dialog
        open={dialog.open}
        onOpenChange={value => {
          if (!value) close();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {isEdit ? t('supplierListPanel.editSupplier') : t('supplierListPanel.newSupplier')}
            </DialogTitle>
            <DialogDescription>
              {isEdit
                ? t('supplierListPanel.editDescription')
                : t('supplierListPanel.newDescription')}
            </DialogDescription>
          </DialogHeader>
          {dialog.open && (
            <SupplierForm
              key={dialog.supplier?.id ?? 'new'}
              initialSupplier={dialog.supplier}
              products={products ?? []}
              submitting={create.isPending || update.isPending}
              onCancel={close}
              onSubmitCreate={value =>
                void create.mutateAsync(value, {
                  onSuccess: result => {
                    if (result.ok) {
                      toast.success(t('supplierListPanel.createdToast', { name: value.name }));
                      close();
                    } else toast.error(result.error.message);
                  },
                })
              }
              onSubmitUpdate={value =>
                void update.mutateAsync(value, {
                  onSuccess: result => {
                    if (result.ok) {
                      toast.success(t('supplierListPanel.updatedToast'));
                      close();
                    } else toast.error(result.error.message);
                  },
                })
              }
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteId}
        title={t('supplierListPanel.deleteSupplierTitle')}
        description={t('supplierListPanel.deleteSupplierBody')}
        confirmLabel={t('supplierListPanel.delete')}
        variant="destructive"
        onCancel={() => {
          setDeleteId(null);
        }}
        onConfirm={() => {
          const id = deleteId;
          setDeleteId(null);
          if (!id) return;
          void remove.mutateAsync(id, {
            onSuccess: result => {
              if (result.ok) {
                toast.success(t('supplierListPanel.deletedToast'));
                return;
              }
              // suppliers ← purchase_orders / shipments are ON DELETE RESTRICT;
              // the shared error mapper turns 23503 into this message.
              // eslint-disable-next-line i18next/no-literal-string -- matches the mapper's fixed 23503 message, not UI copy
              const blocked = result.error.message.includes('related record');
              toast.error(blocked ? t('supplierListPanel.deleteBlocked') : result.error.message);
            },
          });
        }}
      />
    </section>
  );
}
