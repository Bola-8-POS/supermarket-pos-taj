import { FileText, Tags, Truck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  inventoryRowColumns,
  useInventory,
  useNearExpiryAlerts,
  useMutationAdjustInventory,
  type Inventory,
} from '@entities/inventory';
import { useStaffStore } from '@entities/staff/model/store';
import { canAccess } from '@shared/lib/rbac';
import { cn } from '@shared/lib/utils';
import { DataTable } from '@shared/ui/DataTable';
import { FormField } from '@shared/ui/FormField';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { POSButton } from '@shared/ui/POSButton';
import { ProtectedAction } from '@shared/ui/ProtectedAction';
import { SearchInput } from '@shared/ui/SearchInput';
import { SectionHeader } from '@shared/ui/SectionHeader';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';

function stockSortPriority(inv: Inventory): number {
  if (inv.quantityOnHand === 0) return 2;
  if (inv.quantityOnHand <= inv.lowStockThreshold) return 1;
  return 0;
}

function sortInventoryRows(rows: Inventory[]): Inventory[] {
  return [...rows].sort((a, b) => {
    const p = stockSortPriority(b) - stockSortPriority(a);
    if (p !== 0) return p;
    return (a.product?.name ?? '').localeCompare(b.product?.name ?? '', undefined, {
      sensitivity: 'base',
    });
  });
}

function rowHighlightClass(inv: Inventory): string | undefined {
  if (inv.quantityOnHand === 0) {
    // eslint-disable-next-line i18next/no-literal-string -- Tailwind class string, not UI copy
    return 'border-l-2 border-l-destructive bg-destructive/5';
  }
  if (inv.quantityOnHand <= inv.lowStockThreshold) {
    // eslint-disable-next-line i18next/no-literal-string -- Tailwind class string, not UI copy
    return 'border-l-2 border-l-warning bg-warning-soft/60';
  }
  return undefined;
}

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    // eslint-disable-next-line i18next/no-literal-string -- CSV quote-escaping, not UI copy
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function downloadInventoryCsv(rows: Inventory[]) {
  /* eslint-disable i18next/no-literal-string -- machine-readable CSV column keys, not UI copy */
  const headers = [
    'product',
    'category',
    'sku',
    'quantity_on_hand',
    'unit',
    'low_stock_threshold',
    'base_price',
  ];
  /* eslint-enable i18next/no-literal-string */
  const lines = [
    headers.join(','),
    ...rows.map(r => {
      const cells = [
        r.product?.name ?? '',
        r.product?.category?.name ?? '',
        r.product?.sku ?? '',
        String(r.quantityOnHand),
        r.unit,
        String(r.lowStockThreshold),
        r.product?.basePrice != null ? String(r.product.basePrice) : '',
      ];
      return cells.map(escapeCsvField).join(',');
    }),
  ];
  // eslint-disable-next-line i18next/no-literal-string -- MIME type, not UI copy
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

type StockFilter = 'all' | 'low' | 'out' | 'near-expiry';

function FilterTile({
  label,
  value,
  tone,
  pressed,
  onClick,
}: {
  label: string;
  value: ReactNode;
  tone: 'default' | 'warning' | 'destructive';
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'h-auto min-w-[9rem] flex-col items-start gap-1 rounded-xl border border-border bg-card px-4 py-3 text-left shadow-xs hover:bg-card',
        'transition-[border-color,box-shadow] duration-150 hover:border-border-strong',
        pressed && 'border-brand ring-2 ring-brand/30'
      )}
    >
      <span className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </span>
      <span
        className={cn(
          'text-numeric text-2xl font-semibold',
          tone === 'warning' && 'text-warning-strong',
          tone === 'destructive' && 'text-destructive'
        )}
      >
        {value}
      </span>
    </Button>
  );
}

type Props = {
  onOpenCatalog: (() => void) | undefined;
};

export function StockTab({ onOpenCatalog }: Props) {
  const { t } = useTranslation('wAdmin');
  // inventoryRowColumns' header keys ('inventoryRow.columns.*') live in the
  // 'entities' namespace, not 'wAdmin' — a plain wAdmin-scoped t() can't
  // resolve them and falls back to rendering the literal key (Rule 1 fix,
  // found via e2e/44-focus-tab-order.spec.ts surface (b) failing to find a
  // "Product" column-header button; the table was actually rendering
  // "inventoryRow.columns.product").
  const { t: tEntities } = useTranslation('entities');
  const currentStaff = useStaffStore(s => s.currentStaff);
  const currentRole = currentStaff?.role;
  const staffId = currentStaff?.id ?? '';

  const { data, isLoading, resultError, isEmpty } = useInventory();
  const { data: nearExpiryAlerts } = useNearExpiryAlerts();
  const adjustMutation = useMutationAdjustInventory();

  // eslint-disable-next-line i18next/no-literal-string -- sentinel value, not UI copy
  const [categoryFilter, setCategoryFilter] = useState<string>('__all__');
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [search, setSearch] = useState('');
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchProductId, setBatchProductId] = useState<string>('');
  const [batchDelta, setBatchDelta] = useState<string>('1');
  const [batchReason, setBatchReason] = useState<string>('');

  const columns = useMemo(
    () => inventoryRowColumns(tEntities, currentRole),
    [tEntities, currentRole]
  );

  const uniqueCategories = useMemo(() => {
    const set = new Set<string>();
    for (const row of data ?? []) {
      const n = row.product?.category?.name;
      if (n) set.add(n);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const nearExpiryIds = useMemo(
    () => new Set((nearExpiryAlerts ?? []).map(alert => alert.productId)),
    [nearExpiryAlerts]
  );

  const stats = useMemo(() => {
    const rows = data ?? [];
    let lowStock = 0;
    let outOfStock = 0;
    let stockValue = 0;
    let withoutCost = 0;
    for (const r of rows) {
      if (r.quantityOnHand === 0) outOfStock += 1;
      else if (r.quantityOnHand <= r.lowStockThreshold) lowStock += 1;
      if (r.costPrice != null) stockValue += r.quantityOnHand * r.costPrice;
      else withoutCost += 1;
    }
    return {
      totalSkus: rows.length,
      lowStock,
      outOfStock,
      nearExpiry: nearExpiryIds.size,
      stockValue: Math.round(stockValue * 100) / 100,
      withoutCost,
    };
  }, [data, nearExpiryIds]);

  const displayedRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    let rows = data ?? [];
    if (categoryFilter !== '__all__') {
      rows = rows.filter(r => (r.product?.category?.name ?? '') === categoryFilter);
    }
    if (stockFilter === 'low') {
      rows = rows.filter(r => r.quantityOnHand > 0 && r.quantityOnHand <= r.lowStockThreshold);
    } else if (stockFilter === 'out') {
      rows = rows.filter(r => r.quantityOnHand === 0);
    } else if (stockFilter === 'near-expiry') {
      rows = rows.filter(r => nearExpiryIds.has(r.productId));
    }
    if (query) {
      rows = rows.filter(r => {
        const p = r.product;
        return (
          (p?.name ?? '').toLowerCase().includes(query) ||
          (p?.sku ?? '').toLowerCase().includes(query) ||
          (p?.barcode ?? '').toLowerCase().includes(query)
        );
      });
    }
    return sortInventoryRows(rows);
  }, [data, categoryFilter, stockFilter, search, nearExpiryIds]);

  const toggle = (f: StockFilter) => {
    setStockFilter(prev => (prev === f ? 'all' : f));
  };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3">
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t('inventoryPagePanel.searchPlaceholder')}
        className="w-64"
      />
      <label htmlFor="inv-category-filter" className="text-sm text-muted-foreground">
        {t('inventoryPagePanel.categoryLabel')}
      </label>
      <select
        id="inv-category-filter"
        className="h-10 rounded-lg border border-input bg-card px-3 text-sm shadow-xs transition-[border-color,box-shadow] hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none dark:bg-input/20"
        value={categoryFilter}
        onChange={e => {
          setCategoryFilter(e.target.value);
        }}
      >
        <option value="__all__">{t('inventoryPagePanel.allCategories')}</option>
        {uniqueCategories.map(c => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );

  const handleExportCsv = () => {
    if (!displayedRows.length) {
      toast.message(t('inventoryPagePanel.nothingToExport'));
      return;
    }
    downloadInventoryCsv(displayedRows);
    toast.success(t('inventoryPagePanel.csvDownloaded'));
  };

  const handleBatchSubmit = async () => {
    const delta = Number.parseInt(batchDelta, 10);
    if (!batchProductId || Number.isNaN(delta) || delta === 0 || !batchReason) {
      toast.error(t('inventoryPagePanel.chooseProductAndDeltaAndReason'));
      return;
    }
    const res = await adjustMutation.mutateAsync({
      productId: batchProductId,
      quantityDelta: delta,
      reason: batchReason,
      notes: undefined,
    });
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(t('inventoryPagePanel.stockUpdated'));
    setBatchOpen(false);
    setBatchDelta('1');
    setBatchReason('');
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {resultError ? (
        <p className="text-sm text-destructive" role="alert">
          {resultError.message}
        </p>
      ) : null}

      {!staffId ? (
        <p className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm font-medium text-warning-strong">
          {t('inventoryPagePanel.signInBanner')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-stretch gap-3">
        <FilterTile
          label={t('inventoryPagePanel.filterAllSkus')}
          value={stats.totalSkus}
          tone="default"
          pressed={stockFilter === 'all'}
          onClick={() => {
            setStockFilter('all');
          }}
        />
        <FilterTile
          label={t('inventoryPagePanel.lowStock')}
          value={stats.lowStock}
          tone={stats.lowStock > 0 ? 'warning' : 'default'}
          pressed={stockFilter === 'low'}
          onClick={() => {
            toggle('low');
          }}
        />
        <FilterTile
          label={t('inventoryPagePanel.outOfStock')}
          value={stats.outOfStock}
          tone={stats.outOfStock > 0 ? 'destructive' : 'default'}
          pressed={stockFilter === 'out'}
          onClick={() => {
            toggle('out');
          }}
        />
        <FilterTile
          label={t('inventoryPagePanel.nearExpiry')}
          value={stats.nearExpiry}
          tone={stats.nearExpiry > 0 ? 'warning' : 'default'}
          pressed={stockFilter === 'near-expiry'}
          onClick={() => {
            toggle('near-expiry');
          }}
        />
        <div className="min-w-[11rem] rounded-xl border border-border bg-muted/40 px-4 py-3">
          <div className="text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            {t('inventoryPagePanel.stockValue')}
          </div>
          <MoneyDisplay amount={stats.stockValue} size="lg" className="mt-1 block" />
          {stats.withoutCost > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('inventoryPagePanel.stockValueHint', { count: stats.withoutCost })}
            </p>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ProtectedAction action="adjust_inventory" currentRole={currentRole}>
            <POSButton
              type="button"
              touchSize="large"
              variant="secondary"
              onClick={() => {
                setBatchOpen(true);
              }}
            >
              {t('inventoryPagePanel.adjust')}
            </POSButton>
          </ProtectedAction>
          <ProtectedAction action="adjust_inventory" currentRole={currentRole}>
            <POSButton
              type="button"
              touchSize="large"
              variant="outline"
              disabled={displayedRows.length === 0}
              onClick={handleExportCsv}
            >
              {t('inventoryPagePanel.exportCsv')}
            </POSButton>
          </ProtectedAction>
        </div>
      </div>

      {canAccess(currentRole, 'adjust_inventory') && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t('inventoryPagePanel.quickLinksLabel')}</span>
          <Button variant="link" className="h-auto p-0" asChild>
            <Link to="/suppliers">
              <Truck className="size-4" aria-hidden="true" />
              {t('inventoryPagePanel.quickLinkReceive')}
            </Link>
          </Button>
          <Button variant="link" className="h-auto p-0" asChild>
            <Link to="/purchase-orders">
              <FileText className="size-4" aria-hidden="true" />
              {t('inventoryPagePanel.quickLinkPurchaseOrders')}
            </Link>
          </Button>
          {onOpenCatalog && (
            <Button variant="link" className="h-auto p-0" onClick={onOpenCatalog}>
              <Tags className="size-4" aria-hidden="true" />
              {t('inventoryPagePanel.quickLinkCatalog')}
            </Button>
          )}
        </div>
      )}

      <section>
        <SectionHeader
          title={t('inventoryPagePanel.onHandLevelsTitle')}
          description={t('inventoryPagePanel.onHandLevelsDescription')}
        />
        <DataTable<Inventory>
          columns={columns}
          data={displayedRows}
          isLoading={isLoading}
          enableSorting
          toolbar={toolbar}
          getRowClassName={rowHighlightClass}
          emptyState={
            isEmpty ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('inventoryPagePanel.noInventoryRecords')}
              </p>
            ) : (data?.length ?? 0) > 0 && displayedRows.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('inventoryPagePanel.noRowsForFilter')}
              </p>
            ) : undefined
          }
        />
      </section>

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('inventoryPagePanel.batchAdjustmentTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label htmlFor="batch-product" className="text-sm font-medium">
                {t('inventoryPagePanel.productLabel')}
              </label>
              <select
                id="batch-product"
                className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none dark:bg-input/20"
                value={batchProductId}
                onChange={e => {
                  setBatchProductId(e.target.value);
                }}
              >
                <option value="">{t('inventoryPagePanel.selectPlaceholder')}</option>
                {(data ?? []).map(inv => (
                  <option key={inv.productId} value={inv.productId}>
                    {inv.product?.name ?? inv.productId}
                  </option>
                ))}
              </select>
            </div>
            <FormField
              label={t('inventoryPagePanel.quantityDeltaLabel')}
              hint={t('inventoryPagePanel.quantityDeltaHint')}
            >
              {/* eslint-disable-next-line no-restricted-syntax -- 31-CONTEXT.md D-06: signed-delta input, MoneyInput would clamp negatives */}
              <input
                type="number"
                className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none dark:bg-input/20"
                value={batchDelta}
                onChange={e => {
                  setBatchDelta(e.target.value);
                }}
              />
            </FormField>
            <FormField label={t('inventoryPagePanel.reasonLabel')}>
              <select
                className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none dark:bg-input/20"
                value={batchReason}
                onChange={e => {
                  setBatchReason(e.target.value);
                }}
              >
                <option value="">{t('inventoryPagePanel.reasonPlaceholder')}</option>
                <option value="waste">{t('inventoryPagePanel.reasonOptionWaste')}</option>
                <option value="expired">{t('inventoryPagePanel.reasonOptionExpired')}</option>
                <option value="delivery">{t('inventoryPagePanel.reasonOptionDelivery')}</option>
                <option value="correction">
                  {t('inventoryPagePanel.reasonOptionCorrection')}
                </option>
                <option value="manual_adjustment">
                  {t('inventoryPagePanel.reasonOptionManualAdjustment')}
                </option>
                <option value="physical_count">
                  {t('inventoryPagePanel.reasonOptionPhysicalCount')}
                </option>
              </select>
            </FormField>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <POSButton
              type="button"
              variant="outline"
              touchSize="large"
              onClick={() => {
                setBatchOpen(false);
              }}
            >
              {t('inventoryPagePanel.cancel')}
            </POSButton>
            <POSButton
              type="button"
              touchSize="large"
              disabled={adjustMutation.isPending}
              onClick={() => {
                void handleBatchSubmit();
              }}
            >
              {t('inventoryPagePanel.apply')}
            </POSButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
