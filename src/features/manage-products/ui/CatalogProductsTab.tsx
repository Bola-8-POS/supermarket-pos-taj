import type { ColumnDef } from '@tanstack/react-table';
import { ImageOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useBrands } from '@entities/brand';
import { useCategories } from '@entities/category';
import {
  useModifiers,
  useMutationCreateProduct,
  useMutationDeactivateProduct,
  useMutationUpdateProduct,
  useProductImageUrls,
  useProductsForManagement,
  type CreateProductInput,
  type UpdateProductInput,
} from '@entities/product';
import { useProductSupplierIds, useSuppliers } from '@entities/supplier';
import type { Category, Product } from '@shared/lib/domain';
import { ConfirmDialog } from '@shared/ui/ConfirmDialog';
import { DataTable } from '@shared/ui/DataTable';
import { MoneyInput } from '@shared/ui/MoneyInput';
import { POSButton } from '@shared/ui/POSButton';
import { Badge } from '@shared/ui/badge';
import { Input } from '@shared/ui/input';
import { Skeleton } from '@shared/ui/skeleton';

import { ProductDetailDialog } from './ProductDetailDialog';

function modifierIdsOf(p: Product): string[] {
  return p.modifiers.map(m => m.id);
}

function CatalogThumbnailCell({
  hasPhotoPath,
  url,
  isPending,
  noPhotoLabel,
}: {
  hasPhotoPath: boolean;
  url: string | undefined;
  isPending: boolean;
  noPhotoLabel: string;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  const showImage = !!url && !loadFailed;
  const showSkeleton = !showImage && hasPhotoPath && isPending;

  return (
    <div className="size-10 overflow-hidden rounded-md bg-muted" data-testid="catalog-row-thumb">
      {showImage ? (
        <img
          src={url}
          alt=""
          className="size-full object-cover"
          onError={() => {
            setLoadFailed(true);
          }}
        />
      ) : showSkeleton ? (
        <Skeleton className="size-full rounded-md" />
      ) : (
        <div className="flex size-full items-center justify-center">
          <ImageOff className="size-4 text-muted-foreground" />
          <span className="sr-only">{noPhotoLabel}</span>
        </div>
      )}
    </div>
  );
}

function ProductNameCell({
  draftName,
  onDraftChange,
  onCommit,
}: {
  draftName: string;
  onDraftChange: (name: string) => void;
  /** Fires unconditionally on blur — the caller re-reads the current draft
   * live (not a value captured in this render's closure) and decides
   * whether it actually changed, since a fill()-then-blur pair can commit
   * in the very next render after the value changed and a stale captured
   * prop would silently compare the new value against itself. */
  onCommit: () => void;
}) {
  return (
    <Input
      className="h-11 min-w-[8rem]"
      value={draftName}
      onClick={e => {
        e.stopPropagation();
      }}
      onMouseDown={e => {
        e.stopPropagation();
      }}
      onChange={e => {
        onDraftChange(e.target.value);
      }}
      onBlur={onCommit}
    />
  );
}

function ProductCategoryCell({
  product,
  categories,
  draftCategoryId,
  onDraftChange,
  onCommit,
}: {
  product: Product;
  categories: Category[];
  draftCategoryId: string;
  onDraftChange: (id: string) => void;
  onCommit: (categoryId: string) => void;
}) {
  return (
    <select
      className="h-11 max-w-[10rem] rounded-lg border border-input bg-card px-2 text-sm shadow-xs dark:bg-input/20"
      value={draftCategoryId}
      onClick={e => {
        e.stopPropagation();
      }}
      onMouseDown={e => {
        e.stopPropagation();
      }}
      onChange={e => {
        const categoryId = e.target.value;
        onDraftChange(categoryId);
        if (categoryId !== product.categoryId) onCommit(categoryId);
      }}
    >
      {categories.map(c => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function ProductBasePriceCell({
  draftPrice,
  onDraftChange,
  onCommit,
}: {
  draftPrice: number;
  onDraftChange: (v: number) => void;
  /** Fires unconditionally on blur — see ProductNameCell's onCommit doc for
   * why the equality check lives with the caller, not this component. */
  onCommit: () => void;
}) {
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- propagation-stopper only, not an interactive element itself
    <div
      className="min-w-[6rem]"
      onClick={e => {
        e.stopPropagation();
      }}
      onMouseDown={e => {
        e.stopPropagation();
      }}
    >
      <MoneyInput value={draftPrice} onChange={onDraftChange} onBlurCommit={onCommit} />
    </div>
  );
}

export function CatalogProductsTab() {
  const { t } = useTranslation('featMgmt');
  const { data: products, isLoading, resultError } = useProductsForManagement();
  const { data: categories } = useCategories();
  const { data: modifiers } = useModifiers();
  const { data: brands } = useBrands();
  const { data: suppliers } = useSuppliers();

  const createMutation = useMutationCreateProduct();
  const updateMutation = useMutationUpdateProduct();
  const deactivateMutation = useMutationDeactivateProduct();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeProduct, setActiveProduct] = useState<Product | null>(null);
  const { data: editSupplierIds } = useProductSupplierIds(activeProduct?.id);
  const [deactivateId, setDeactivateId] = useState<string | null>(null);
  const { urls: photoUrls, isPending: photosPending } = useProductImageUrls(products ?? []);

  // D-11: brand/weight-unit filter dropdowns above the table, composing with
  // (not replacing) DataTable's own `searchable` text filter — plain
  // useState + array .filter(), no new filter-panel component.
  const [brandFilter, setBrandFilter] = useState('');
  const [weightUnitFilter, setWeightUnitFilter] = useState('');
  const filteredProducts = (products ?? []).filter(
    p =>
      (brandFilter === '' || p.brandId === brandFilter) &&
      (weightUnitFilter === '' || p.weightUnit === weightUnitFilter)
  );

  const openDetailDialog = useCallback((p: Product) => {
    setActiveProduct(p);
    setDialogOpen(true);
  }, []);

  const [drafts, setDrafts] = useState<
    Record<string, { name: string; basePrice: number; categoryId: string }>
  >({});

  // `stableColumns` below must be a stable reference: TanStack Table's
  // `flexRender` treats any function passed as `cell` as a genuine component
  // type (tanstack/react-table's `isReactComponent` matches
  // `typeof x === 'function'`), so a `columns` array rebuilt on every render
  // — recreating a new `cell` closure each time — makes React unmount and
  // remount every table cell on every keystroke. That silently drops focus
  // and discards in-flight interactions (e.g. a price-input `fill()` +
  // `blur()` in the same tick: the fill's own state update remounts the
  // input before blur can commit, so the blur event never reaches a focused
  // element and the edit is lost without any error). Fix: memoize
  // `stableColumns` and have its cell closures read frequently-changing
  // values (drafts, products) through refs instead of directly through
  // render-scoped variables, so the cell closures never need to change
  // identity to see current data.
  const productsRef = useRef(products);
  const draftsRef = useRef(drafts);
  // updateMutation itself (from TanStack Query's useMutation) is a new object
  // every render even while idle, so closing over it directly (as `runUpdate`
  // did) also defeats the columns memoization above — same fix, same reason.
  const updateMutationRef = useRef(updateMutation);
  // Refs are synced post-commit (not written during render — react-hooks/refs
  // forbids that) via one combined effect; a one-render-late ref value is
  // irrelevant here since these are only read from event handlers/callbacks
  // that fire well after the commit that updated them.
  useEffect(() => {
    productsRef.current = products;
    draftsRef.current = drafts;
    updateMutationRef.current = updateMutation;
  });

  const getDraft = useCallback(
    (p: Product) =>
      draftsRef.current[p.id] ?? {
        name: p.name,
        basePrice: p.basePrice,
        categoryId: p.categoryId,
      },
    []
  );

  const setDraft = useCallback(
    (id: string, partial: Partial<{ name: string; basePrice: number; categoryId: string }>) => {
      setDrafts(prev => {
        const base = prev[id];
        const product = productsRef.current?.find(x => x.id === id);
        if (!product) return prev;
        const cur = base ?? {
          name: product.name,
          basePrice: product.basePrice,
          categoryId: product.categoryId,
        };
        return { ...prev, [id]: { ...cur, ...partial } };
      });
    },
    []
  );

  const clearDraft = useCallback((id: string) => {
    setDrafts(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)));
  }, []);

  const runUpdate = useCallback(
    (input: UpdateProductInput, successMessage: string, clearId?: string) => {
      void updateMutationRef.current.mutateAsync(input, {
        onSuccess: r => {
          if (!r.ok) toast.error(r.error.message);
          else {
            toast.success(successMessage);
            if (clearId) clearDraft(clearId);
          }
        },
      });
    },
    [clearDraft]
  );

  const catList = useMemo(() => categories ?? [], [categories]);

  // The photo column is intentionally NOT part of the memoized `stableColumns`
  // below: it reads `photoUrls`/`photosPending` directly (fresh every render)
  // rather than through a ref. A ref here would suffer the same one-render
  // lag as `drafts` did (`react-hooks/refs` forbids a synchronous same-render
  // ref write, so the sync can only happen in a post-commit effect) — but
  // unlike a keystroke, nothing else re-renders the table once a background
  // signing query resolves, so a lagged ref would leave the thumbnail frozen
  // on its skeleton forever. Rebuilding this one column every render is safe
  // because, unlike the interactive cells below, a thumbnail carries no
  // focus or in-progress input to lose on remount.
  const photoColumn: ColumnDef<Product> = {
    id: 'photo',
    header: t('manageProducts.productsTab.photoHeader'),
    cell: ({ row }) => {
      const p = row.original;
      return (
        <CatalogThumbnailCell
          hasPhotoPath={!!p.photoPath}
          url={p.photoPath ? photoUrls.get(p.photoPath) : undefined}
          isPending={photosPending}
          noPhotoLabel={t('manageProducts.productsTab.noPhoto')}
        />
      );
    },
  };

  const stableColumns: ColumnDef<Product>[] = useMemo(
    () => [
      {
        id: 'name',
        header: t('manageProducts.productsTab.nameHeader'),
        cell: ({ row }) => {
          const p = row.original;
          const d = getDraft(p);
          return (
            <ProductNameCell
              draftName={d.name}
              onDraftChange={name => {
                setDraft(p.id, { name });
              }}
              onCommit={() => {
                const name = getDraft(p).name;
                if (name !== p.name) {
                  runUpdate(
                    { id: p.id, name, modifierIds: modifierIdsOf(p) },
                    t('manageProducts.productsTab.productUpdated'),
                    p.id
                  );
                }
              }}
            />
          );
        },
      },
      {
        id: 'category',
        header: t('manageProducts.productsTab.categoryHeader'),
        cell: ({ row }) => {
          const p = row.original;
          const d = getDraft(p);
          return (
            <ProductCategoryCell
              product={p}
              categories={catList}
              draftCategoryId={d.categoryId}
              onDraftChange={categoryId => {
                setDraft(p.id, { categoryId });
              }}
              onCommit={categoryId => {
                runUpdate(
                  { id: p.id, categoryId, modifierIds: modifierIdsOf(p) },
                  t('manageProducts.productsTab.categoryUpdated'),
                  p.id
                );
              }}
            />
          );
        },
      },
      {
        id: 'basePrice',
        header: t('manageProducts.productsTab.baseHeader'),
        cell: ({ row }) => {
          const p = row.original;
          const d = getDraft(p);
          return (
            <ProductBasePriceCell
              draftPrice={d.basePrice}
              onDraftChange={basePrice => {
                setDraft(p.id, { basePrice });
              }}
              onCommit={() => {
                const basePrice = getDraft(p).basePrice;
                if (basePrice !== p.basePrice) {
                  runUpdate(
                    { id: p.id, basePrice, modifierIds: modifierIdsOf(p) },
                    t('manageProducts.productsTab.priceUpdated'),
                    p.id
                  );
                }
              }}
            />
          );
        },
      },
      {
        id: 'active',
        header: t('manageProducts.productsTab.statusHeader'),
        cell: ({ row }) => {
          const p = row.original;
          return (
            <Badge variant={p.isActive ? 'default' : 'secondary'}>
              {p.isActive
                ? t('manageProducts.productsTab.active')
                : t('manageProducts.productsTab.inactive')}
            </Badge>
          );
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="flex flex-wrap gap-1">
              <POSButton
                type="button"
                touchSize="default"
                variant="outline"
                onClick={e => {
                  e.stopPropagation();
                  openDetailDialog(p);
                }}
              >
                {t('manageProducts.productsTab.edit')}
              </POSButton>
              <POSButton
                type="button"
                touchSize="default"
                variant="outline"
                disabled={!p.isActive}
                onClick={e => {
                  e.stopPropagation();
                  setDeactivateId(p.id);
                }}
              >
                {t('manageProducts.productsTab.deactivate')}
              </POSButton>
            </div>
          );
        },
      },
    ],
    [t, catList, getDraft, setDraft, runUpdate, openDetailDialog]
  );

  const columns: ColumnDef<Product>[] = [photoColumn, ...stableColumns];

  if (resultError) {
    return (
      <p className="text-destructive text-sm">
        {t('manageProducts.productsTab.loadError', { message: resultError.message })}
      </p>
    );
  }

  const modList = modifiers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {t('manageProducts.productsTab.headerHelp')}
        </p>
        <POSButton
          type="button"
          touchSize="default"
          onClick={() => {
            setActiveProduct(null);
            setDialogOpen(true);
          }}
        >
          {t('manageProducts.productsTab.addProduct')}
        </POSButton>
      </div>

      <DataTable<Product>
        columns={columns}
        data={filteredProducts}
        isLoading={isLoading}
        toolbar={
          <>
            <select
              className="h-10 rounded-lg border border-input bg-card px-3 text-sm shadow-xs dark:bg-input/20"
              aria-label={t('manageProducts.productsTab.brandFilterLabel')}
              value={brandFilter}
              onChange={e => {
                setBrandFilter(e.target.value);
              }}
            >
              <option value="">{t('manageProducts.productsTab.allBrands')}</option>
              {(brands ?? []).map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <select
              className="h-10 rounded-lg border border-input bg-card px-3 text-sm shadow-xs dark:bg-input/20"
              aria-label={t('manageProducts.productsTab.weightUnitFilterLabel')}
              value={weightUnitFilter}
              onChange={e => {
                setWeightUnitFilter(e.target.value);
              }}
            >
              <option value="">{t('manageProducts.productsTab.allWeightUnits')}</option>
              {
                // eslint-disable-next-line i18next/no-literal-string -- unit codes (matches the weight_unit enum values), not UI copy
                (['g', 'kg', 'lb', 'oz'] as const).map(u => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))
              }
            </select>
          </>
        }
        searchable
        searchPlaceholder={t('manageProducts.productsTab.searchPlaceholder')}
        enableSorting
        onRowClick={openDetailDialog}
        // eslint-disable-next-line i18next/no-literal-string -- Tailwind class names, not UI copy
        getRowClassName={() => 'hover:bg-muted/50 transition-colors duration-150'}
      />

      <ProductDetailDialog
        key={activeProduct?.id ?? 'create'}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        categories={catList}
        modifiers={modList}
        brands={brands ?? []}
        products={products ?? []}
        suppliers={suppliers ?? []}
        supplierIds={editSupplierIds}
        initialProduct={activeProduct}
        submitting={activeProduct ? updateMutation.isPending : createMutation.isPending}
        onSubmitCreate={payload => {
          const input: CreateProductInput = { ...payload, modifierIds: payload.modifierIds };
          void createMutation.mutateAsync(input, {
            onSuccess: r => {
              if (!r.ok) toast.error(r.error.message);
              else {
                toast.success(t('manageProducts.productsTab.productCreated'));
                // Create-then-stay (D-03): the dialog stays open, now in edit
                // mode for the just-created product — a photo needs a real
                // product id, so it cannot be attached before this point.
                setActiveProduct(r.data);
              }
            },
          });
        }}
        onSubmitUpdate={payload => {
          void updateMutation.mutateAsync(payload, {
            onSuccess: r => {
              if (!r.ok) toast.error(r.error.message);
              else {
                toast.success(t('manageProducts.productsTab.productSaved'));
                setDialogOpen(false);
              }
            },
          });
        }}
      />

      <ConfirmDialog
        open={deactivateId != null}
        title={t('manageProducts.productsTab.deactivateProductTitle')}
        description={t('manageProducts.productsTab.deactivateProductDescription')}
        confirmLabel={t('manageProducts.productsTab.deactivateProductConfirmLabel')}
        variant="destructive"
        isLoading={deactivateMutation.isPending}
        onConfirm={async () => {
          if (deactivateId == null) return;
          const id = deactivateId;
          const r = await deactivateMutation.mutateAsync(id);
          setDeactivateId(null);
          if (!r.ok) toast.error(r.error.message);
          else toast.success(t('manageProducts.productsTab.productDeactivated'));
        }}
        onCancel={() => {
          setDeactivateId(null);
        }}
      />
    </div>
  );
}
