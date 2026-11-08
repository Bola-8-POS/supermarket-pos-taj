import { Package, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useSuggestReorder } from '@features/suggest-reorder';
import { useInventory } from '@entities/inventory';
import { ProductLookupInput, useProductsForManagement } from '@entities/product';
import type {
  PurchaseOrder,
  PurchaseOrderCreate,
  PurchaseOrderItemCreate,
} from '@entities/purchase-order';
import { useSuppliers } from '@entities/supplier';
import type { Result } from '@shared/lib/result';
import { cn } from '@shared/lib/utils';
import { EmptyState } from '@shared/ui/EmptyState';
import { FormField } from '@shared/ui/FormField';
import { LockedFeature } from '@shared/ui/LockedFeature';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { MoneyInput } from '@shared/ui/MoneyInput';
import { POSButton } from '@shared/ui/POSButton';
import { DialogFooter } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';

type Line = { key: number; productId: string; search: string; quantity: number; costPrice: number };
let lineSeq = 0;
const newLine = (partial: Partial<Line> = {}): Line => ({
  key: ++lineSeq,
  productId: '',
  search: '',
  quantity: 1,
  costPrice: 0,
  ...partial,
});

// Native <select>, styled like `Input` (the e2e suite drives it with `selectOption`).
const NATIVE_SELECT_CLASS =
  'flex h-11 w-full rounded-lg border border-input bg-card px-3.5 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 dark:bg-input/20';

const GRID = 'grid grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_6.5rem_2.75rem] items-center gap-2';

export function PurchaseOrderForm({
  initialPurchaseOrder,
  submitting,
  onCancel,
  onSubmitCreate,
  onSubmitUpdate,
}: {
  initialPurchaseOrder: PurchaseOrder | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmitCreate: (value: PurchaseOrderCreate) => Promise<Result<PurchaseOrder>>;
  onSubmitUpdate: (value: {
    id: string;
    supplierId: string;
    items: PurchaseOrderItemCreate[];
  }) => void;
}) {
  const { t } = useTranslation('featMgmt');
  const { data: suppliers } = useSuppliers();
  const { data: products } = useProductsForManagement();
  const { data: inventory } = useInventory();
  const [supplierId, setSupplierId] = useState(initialPurchaseOrder?.supplierId ?? '');
  const [lines, setLines] = useState<Line[]>(
    () =>
      initialPurchaseOrder?.items?.map(i =>
        newLine({
          productId: i.productId,
          search: i.product?.name ?? '',
          quantity: i.quantity,
          costPrice: i.costPrice,
        })
      ) ?? []
  );
  const [error, setError] = useState('');
  const suggestion = useSuggestReorder(supplierId || undefined);

  const update = (index: number, patch: Partial<Line>) => {
    setLines(v => v.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };
  const total = lines.reduce((sum, l) => sum + l.quantity * l.costPrice, 0);
  const invalid =
    submitting ||
    !supplierId ||
    lines.length === 0 ||
    lines.some(line => !line.productId || !(line.quantity > 0));

  const submit = async () => {
    setError('');
    const items: PurchaseOrderItemCreate[] = lines.map(({ productId, quantity, costPrice }) => ({
      productId,
      quantity,
      costPrice,
    }));
    if (initialPurchaseOrder) {
      onSubmitUpdate({ id: initialPurchaseOrder.id, supplierId, items });
      return;
    }
    const result = await onSubmitCreate({ supplierId, items });
    if (!result.ok) {
      setError(t('purchaseOrderForm.saveError'));
      return;
    }
    toast.success(t('purchaseOrderForm.created'));
    onCancel();
  };

  const applySuggestion = () => {
    if (!suggestion.data) return;
    setLines(
      suggestion.data.map(s =>
        newLine({
          productId: s.productId,
          search: s.productName,
          quantity: s.quantity,
          costPrice: s.costPrice,
        })
      )
    );
  };

  const showNoReorderNeeded = !!supplierId && lines.length === 0 && suggestion.data?.length === 0;
  const suggestHint = !supplierId
    ? t('purchaseOrderForm.chooseSupplierHint')
    : lines.length > 0
      ? t('purchaseOrderForm.suggestOnlyWhenEmpty')
      : undefined;

  return (
    <div className="space-y-5">
      <FormField
        label={t('receiveShipment.supplier')}
        required
        {...(!supplierId ? { hint: t('purchaseOrderForm.chooseSupplierHint') } : {})}
      >
        <select
          className={NATIVE_SELECT_CLASS}
          value={supplierId}
          onChange={e => {
            setSupplierId(e.target.value);
          }}
          disabled={submitting}
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
        showNoReorderNeeded ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            {t('purchaseOrderForm.noReorderNeeded')}
          </p>
        ) : (
          <EmptyState
            icon={Package}
            title={t('purchaseOrderForm.emptyTitle')}
            description={t('purchaseOrderForm.emptyBody')}
          />
        )
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
            <span className="text-right">{t('receiveShipment.subtotal')}</span>
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
                      disabled={submitting}
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
                      <p className="text-xs text-destructive">{t('receiveShipment.noMatch')}</p>
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
                    disabled={submitting}
                    onChange={e => {
                      update(index, { quantity: Number(e.target.value) });
                    }}
                  />
                  <MoneyInput
                    ariaLabel={t('receiveShipment.cost')}
                    value={line.costPrice}
                    disabled={submitting}
                    onChange={costPrice => {
                      update(index, { costPrice });
                    }}
                  />
                  <MoneyDisplay
                    amount={line.quantity * line.costPrice}
                    className="justify-self-end"
                  />
                  <POSButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('receiveShipment.removeLine')}
                    disabled={submitting}
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

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <DialogFooter showCloseButton={false} className="sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <POSButton
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => {
              setLines(v => [...v, newLine()]);
            }}
          >
            <Plus className="size-4" />
            {t('receiveShipment.addLine')}
          </POSButton>
          <POSButton
            type="button"
            variant="outline"
            disabled={!supplierId || lines.length > 0 || submitting}
            {...(suggestHint ? { title: suggestHint } : {})}
            onClick={applySuggestion}
          >
            <Sparkles className="size-4" />
            {t('purchaseOrderForm.suggestReorder')}
          </POSButton>
        </div>
        <div className="flex gap-2">
          <POSButton type="button" variant="ghost" disabled={submitting} onClick={onCancel}>
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
              {submitting ? t('common:actions.saving') : t('purchaseOrderForm.save')}
            </POSButton>
          </LockedFeature>
        </div>
      </DialogFooter>
    </div>
  );
}
