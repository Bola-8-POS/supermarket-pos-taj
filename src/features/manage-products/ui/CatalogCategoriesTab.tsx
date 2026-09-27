import { ArrowDown, ArrowUp, Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useCategories,
  useMutationCreateCategory,
  useMutationUpdateCategory,
} from '@entities/category';
import type { Category } from '@shared/lib/domain';
import { POSButton } from '@shared/ui/POSButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';

import { CategoryForm } from './CategoryForm';

export function CatalogCategoriesTab() {
  const { t } = useTranslation('featMgmt');
  const { data: categories, isLoading, resultError } = useCategories();
  const createMutation = useMutationCreateCategory();
  const updateMutation = useMutationUpdateCategory();

  const [createOpen, setCreateOpen] = useState(false);
  const [editCategory, setEditCategory] = useState<Category | null>(null);

  const sorted = useMemo(
    () =>
      [...(categories ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
      ),
    [categories]
  );

  async function swapOrder(a: Category, b: Category) {
    const r1 = await updateMutation.mutateAsync({
      id: a.id,
      sortOrder: b.sortOrder,
    });
    if (!r1.ok) {
      toast.error(r1.error.message);
      return;
    }
    const r2 = await updateMutation.mutateAsync({
      id: b.id,
      sortOrder: a.sortOrder,
    });
    if (!r2.ok) toast.error(r2.error.message);
    else toast.success(t('manageProducts.categoriesTab.orderUpdated'));
  }

  if (resultError) {
    return (
      <p className="text-destructive text-sm">
        {t('manageProducts.categoriesTab.loadError', { message: resultError.message })}
      </p>
    );
  }

  if (isLoading) {
    return (
      <p className="text-muted-foreground text-sm">{t('manageProducts.categoriesTab.loading')}</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {t('manageProducts.categoriesTab.headerHelp')}
        </p>
        <POSButton
          type="button"
          touchSize="default"
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          {t('manageProducts.categoriesTab.addCategory')}
        </POSButton>
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        {sorted.map((c, index) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span
              className="size-4 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: c.color }}
              title={c.color}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{c.name}</p>
              <p className="text-muted-foreground text-xs">
                {t('manageProducts.categoriesTab.sort', { order: c.sortOrder })}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <POSButton
                type="button"
                variant="outline"
                touchSize="default"
                size="icon"
                disabled={index === 0 || updateMutation.isPending}
                aria-label={t('manageProducts.categoriesTab.moveUpAria')}
                onClick={() => {
                  const prev = sorted[index - 1];
                  if (prev) void swapOrder(c, prev);
                }}
              >
                <ArrowUp className="size-4" />
              </POSButton>
              <POSButton
                type="button"
                variant="outline"
                touchSize="default"
                size="icon"
                disabled={index >= sorted.length - 1 || updateMutation.isPending}
                aria-label={t('manageProducts.categoriesTab.moveDownAria')}
                onClick={() => {
                  const next = sorted[index + 1];
                  if (next) void swapOrder(c, next);
                }}
              >
                <ArrowDown className="size-4" />
              </POSButton>
              <POSButton
                type="button"
                variant="outline"
                touchSize="default"
                size="icon"
                onClick={() => {
                  setEditCategory(c);
                }}
              >
                <Pencil className="size-4" />
                <span className="sr-only">{t('manageProducts.categoriesTab.edit')}</span>
              </POSButton>
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>{t('manageProducts.categoriesTab.newCategoryTitle')}</DialogTitle>
          </DialogHeader>
          <CategoryForm
            submitting={createMutation.isPending}
            onCancel={() => {
              setCreateOpen(false);
            }}
            onSubmitCreate={data => {
              void createMutation.mutateAsync(data, {
                onSuccess: r => {
                  if (!r.ok) toast.error(r.error.message);
                  else {
                    toast.success(t('manageProducts.categoriesTab.categoryCreated'));
                    setCreateOpen(false);
                  }
                },
              });
            }}
            onSubmitUpdate={() => {}}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={editCategory != null}
        onOpenChange={o => {
          if (!o) setEditCategory(null);
        }}
      >
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle>{t('manageProducts.categoriesTab.editCategoryTitle')}</DialogTitle>
          </DialogHeader>
          {editCategory ? (
            <CategoryForm
              key={editCategory.id}
              initialCategory={editCategory}
              submitting={updateMutation.isPending}
              onCancel={() => {
                setEditCategory(null);
              }}
              onSubmitCreate={() => {}}
              onSubmitUpdate={data => {
                void updateMutation.mutateAsync(data, {
                  onSuccess: r => {
                    if (!r.ok) toast.error(r.error.message);
                    else {
                      toast.success(t('manageProducts.categoriesTab.categorySaved'));
                      setEditCategory(null);
                    }
                  },
                });
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
