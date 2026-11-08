import { Package, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useCategories } from '@entities/category';
import { useInventory } from '@entities/inventory';
import {
  ProductLookupInput,
  useMutationCreateProduct,
  useProductsForManagement,
} from '@entities/product';
import { useSuppliers } from '@entities/supplier';
import { cn } from '@shared/lib/utils';
import { EmptyState } from '@shared/ui/EmptyState';
import { FormField } from '@shared/ui/FormField';
import { LockedFeature } from '@shared/ui/LockedFeature';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { MoneyInput } from '@shared/ui/MoneyInput';
import { POSButton } from '@shared/ui/POSButton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { useReceiveShipment } from '../model/useReceiveShipment';

type Line = {
  key: number;
  productId: string;
  search: string;
  quantity: number;
  costPrice: number;
  expiryDate: string | null;
};
let lineSeq = 0;
const newLine = (partial: Partial<Line> = {}): Line => ({
  key: ++lineSeq,
  productId: '',
  search: '',
  quantity: 1,
  costPrice: 0,
  expiryDate: null,
  ...partial,
});

type InitialPurchaseOrder = {
  id: string;
  supplierId: string;
  items: { productId: string; productName: string; quantity: number; costPrice: number }[];
};

// Native <select>, styled like `Input` (the e2e suite drives it with `selectOption`).
const NATIVE_SELECT_CLASS =
  'flex h-11 w-full rounded-lg border border-input bg-card px-3.5 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 dark:bg-input/20';

const GRID = 'grid grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_9.75rem_2.75rem] items-center gap-2';

export function ReceiveShipmentForm({
  open,
  onOpenChange,
  initialPurchaseOrder = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPurchaseOrder?: InitialPurchaseOrder | null;
}) {
  const { t } = useTranslation('featMgmt');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('receiveShipment.confirm')}</DialogTitle>
          <DialogDescription>{t('receiveShipment.description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open so every open starts from a clean draft. */}
        {open && (
          <ReceiveShipmentBody
            key={initialPurchaseOrder?.id ?? 'new'}
            initialPurchaseOrder={initialPurchaseOrder}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReceiveShipmentBody({
  initialPurchaseOrder,
  onClose,
}: {
  initialPurchaseOrder: InitialPurchaseOrder | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('featMgmt');
  const { data: suppliers } = useSuppliers();
  const { data: products } = useProductsForManagement();
  const { data: inventory } = useInventory();
  const { data: categories } = useCategories();
  const receive = useReceiveShipment();
  const create = useMutationCreateProduct();
  const [supplierId, setSupplierId] = useState(initialPurchaseOrder?.supplierId ?? '');
  const [lines, setLines] = useState<Line[]>(() =>
    initialPurchaseOrder
      ? initialPurchaseOrder.items.map(i =>
          newLine({
            productId: i.productId,
            search: i.productName,
            quantity: i.quantity,
            costPrice: i.costPrice,
          })
        )
      : []
  );
  const [error, setError] = useState('');
  const [quick, setQuick] = useState<{
    index: number;
    name: string;
    barcode: string;
    categoryId: string;
    price: number;
  } | null>(null);
  const [quickError, setQuickError] = useState('');

  const update = (index: number, patch: Partial<Line>) => {
    setLines(v => v.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };
  const total = lines.reduce((sum, l) => sum + l.quantity * l.costPrice, 0);
  const invalid =
    receive.isPending ||
    !supplierId ||
    lines.length === 0 ||
    lines.some(line => !line.productId || !(line.quantity > 0));

  const submit = async () => {
    setError('');
    const result = await receive.mutateAsync({
      supplierId,
      items: lines.map(({ productId, quantity, costPrice, expiryDate }) => ({
        productId,
        quantity,
        costPrice,
        expiryDate,
      })),
      poId: initialPurchaseOrder?.id ?? undefined,
    });
    if (!result.ok) {
      // The RPC's raw error code (e.g. PO_ALREADY_RECEIVED) survives only in
      // `details` — the shared edge-error mapper has no explicit case for it,
      // so `code` collapses to the generic 'SUPABASE_ERROR'.
      if (result.error.details === 'PO_ALREADY_RECEIVED') {
        toast.error(t('purchaseOrderDetailPanel.alreadyReceivedError', { ns: 'wAdmin' }));
      } else {
        setError(t('receiveShipment.error'));
      }
      return;
    }
    toast.success(t('receiveShipment.confirm'));
    onClose();
  };

  const addProduct = async () => {
    if (!quick) return;
    setQuickError('');
    const result = await create.mutateAsync({
      name: quick.name,
      categoryId: quick.categoryId,
      basePrice: quick.price,
      happyHourPrice: null,
      sku: null,
      isActive: true,
      soldByWeight: false,
      imageUrl: null,
      photoPath: null,
      barcode: quick.barcode || null,
      unitsPerPackage: null,
      parentProductId: null,
      brandId: null,
      weightAmount: null,
      weightUnit: null,
      stock_threshold: null,
      comboEligible: true,
      isCombo: false,
      modifierIds: [],
    });
    if (!result.ok) {
      setQuickError(
        result.error.code === 'DUPLICATE_ENTRY'
          ? t('receiveShipment.duplicateBarcode')
          : result.error.message
      );
      return;
    }
    update(quick.index, { productId: result.data.id, search: result.data.name });
    setQuick(null);
  };

  return (
    <div className="space-y-5">
      <FormField label={t('receiveShipment.supplier')} required>
        <select
          className={NATIVE_SELECT_CLASS}
          value={supplierId}
          onChange={e => {
            setSupplierId(e.target.value);
          }}
          disabled={!!initialPurchaseOrder || receive.isPending}
        >
          <option value="" />
          {suppliers?.map(s => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </FormField>

      {lines.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t('receiveShipment.emptyTitle')}
          description={t('receiveShipment.emptyBody')}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div
            aria-hidden="true"
            className={cn(
              GRID,
              'border-b border-border bg-muted/40 px-3 py-2 text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase'
            )}
          >
            <span>{t('receiveShipment.product')}</span>
            <span>{t('receiveShipment.quantity')}</span>
            <span>{t('receiveShipment.cost')}</span>
            <span>{t('receiveShipment.expiry')}</span>
            <span />
          </div>
          <ul className="max-h-72 divide-y divide-border overflow-y-auto">
            {lines.map((line, index) => {
              const unmatched = !!line.search && !line.productId;
              return (
                <li key={line.key} className={cn(GRID, 'px-3 py-2')}>
                  <div className="min-w-0 space-y-1">
                    <ProductLookupInput
                      products={products ?? []}
                      value={line.search}
                      aria-label={t('receiveShipment.product')}
                      placeholder={t('receiveShipment.productPlaceholder')}
                      invalid={unmatched}
                      disabled={receive.isPending}
                      onChange={({ search, product }) => {
                        update(
                          index,
                          product
                            ? {
                                search,
                                productId: product.id,
                                costPrice:
                                  inventory?.find(i => i.productId === product.id)?.costPrice ??
                                  line.costPrice,
                              }
                            : { search, productId: '' }
                        );
                      }}
                    />
                    {unmatched ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <p className="text-xs text-destructive">{t('receiveShipment.noMatch')}</p>
                        <POSButton
                          type="button"
                          variant="outline"
                          disabled={receive.isPending}
                          onClick={() => {
                            setQuickError('');
                            setQuick({
                              index,
                              name: line.search,
                              barcode: /^\d{6,}$/.test(line.search) ? line.search : '',
                              categoryId: categories?.[0]?.id ?? '',
                              price: 0,
                            });
                          }}
                        >
                          {t('receiveShipment.addProduct')}
                        </POSButton>
                      </div>
                    ) : null}
                  </div>
                  <Input
                    type="number"
                    inputMode="numeric"
                    aria-label={t('receiveShipment.quantity')}
                    min="1"
                    step="1"
                    className="text-numeric"
                    value={line.quantity}
                    disabled={receive.isPending}
                    onChange={e => {
                      update(index, { quantity: Number(e.target.value) });
                    }}
                  />
                  <MoneyInput
                    ariaLabel={t('receiveShipment.cost')}
                    value={line.costPrice}
                    disabled={receive.isPending}
                    onChange={costPrice => {
                      update(index, { costPrice });
                    }}
                  />
                  <Input
                    type="date"
                    aria-label={t('receiveShipment.expiry')}
                    value={line.expiryDate ?? ''}
                    disabled={receive.isPending}
                    onChange={e => {
                      update(index, { expiryDate: e.target.value || null });
                    }}
                  />
                  <POSButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('receiveShipment.removeLine')}
                    disabled={receive.isPending}
                    onClick={() => {
                      setLines(v => v.filter((_, i) => i !== index));
                    }}
                  >
                    <Trash2 className="size-4" />
                  </POSButton>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-2 text-sm">
            <span className="font-medium">{t('receiveShipment.total')}</span>
            <MoneyDisplay amount={total} className="font-semibold" />
          </div>
        </div>
      )}

      {quick && (
        <section className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
          <div className="space-y-0.5">
            <h3 className="text-base font-semibold tracking-tight">
              {t('receiveShipment.quickAddTitle')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('receiveShipment.quickAddHint')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('manageProducts.productForm.nameLabel')} required>
              <Input
                value={quick.name}
                onChange={e => {
                  setQuick({ ...quick, name: e.target.value });
                }}
              />
            </FormField>
            <FormField label={t('manageProducts.productForm.barcodeLabel')}>
              <Input
                value={quick.barcode}
                inputMode="numeric"
                onChange={e => {
                  setQuick({ ...quick, barcode: e.target.value });
                }}
              />
            </FormField>
            <FormField label={t('manageProducts.productForm.categoryLabel')} required>
              <select
                className={NATIVE_SELECT_CLASS}
                value={quick.categoryId}
                onChange={e => {
                  setQuick({ ...quick, categoryId: e.target.value });
                }}
              >
                {categories?.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </FormField>
            <MoneyInput
              label={t('receiveShipment.salePrice')}
              value={quick.price}
              onChange={price => {
                setQuick({ ...quick, price });
              }}
            />
          </div>
          {quickError && (
            <p className="text-sm text-destructive" role="alert">
              {quickError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <POSButton
              type="button"
              variant="ghost"
              onClick={() => {
                setQuick(null);
              }}
            >
              {t('receiveShipment.cancelQuickAdd')}
            </POSButton>
            <POSButton
              type="button"
              variant="brand"
              disabled={create.isPending || !quick.name.trim() || !quick.categoryId}
              onClick={() => void addProduct()}
            >
              {t('receiveShipment.addProduct')}
            </POSButton>
          </div>
        </section>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <DialogFooter showCloseButton={false} className="sm:justify-between">
        <POSButton
          type="button"
          variant="outline"
          disabled={receive.isPending}
          onClick={() => {
            setLines(v => [...v, newLine()]);
          }}
        >
          <Plus className="size-4" />
          {t('receiveShipment.addLine')}
        </POSButton>
        <div className="flex gap-2">
          <POSButton type="button" variant="ghost" disabled={receive.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </POSButton>
          <LockedFeature feature="purchase_orders">
            <POSButton
              type="button"
              variant="brand"
              focusEmphasis="high"
              onClick={() => void submit()}
              disabled={invalid}
            >
              {receive.isPending ? t('common:actions.saving') : t('receiveShipment.confirm')}
            </POSButton>
          </LockedFeature>
        </div>
      </DialogFooter>
    </div>
  );
}
