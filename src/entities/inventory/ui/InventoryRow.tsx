import { createColumnHelper, type Column } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type Inventory, InventoryAdjustReason } from '@shared/lib/domain';
import type { StaffRole } from '@shared/lib/rbac';
import { cn } from '@shared/lib/utils';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { ProtectedAction } from '@shared/ui/ProtectedAction';
import { QuantityControl } from '@shared/ui/QuantityControl';
import { StatusBadge, type InventoryStockBadgeStatus } from '@shared/ui/StatusBadge';
import { Badge } from '@shared/ui/badge';
import { TableCell, TableRow } from '@shared/ui/table';
import { useMutationAdjustInventory } from '../model/queries';

const ch = createColumnHelper<Inventory>();

function SortHeader({ column, title }: { column: Column<Inventory>; title: string }) {
  if (!column.getCanSort()) {
    return <span>{title}</span>;
  }
  const sorted = column.getIsSorted();
  return (
    <button
      type="button"
      className="-ml-2 inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 text-left text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase transition-colors touch-manipulation hover:bg-muted hover:text-foreground"
      onClick={e => {
        column.getToggleSortingHandler()?.(e);
      }}
    >
      {title}
      {sorted === 'asc' ? ' \u2191' : sorted === 'desc' ? ' \u2193' : ''}
    </button>
  );
}

function stockTier(inventory: Inventory): InventoryStockBadgeStatus {
  const { quantityOnHand, lowStockThreshold } = inventory;
  if (quantityOnHand === 0) return 'inv_out_of_stock';
  if (quantityOnHand <= lowStockThreshold) return 'inv_low_stock';
  return 'inv_in_stock';
}

function isLowStock(inventory: Inventory): boolean {
  return inventory.quantityOnHand <= inventory.lowStockThreshold;
}

function ProductCell({ inventory }: { inventory: Inventory }) {
  return <span className="font-medium">{inventory.product?.name ?? '—'}</span>;
}

function CategoryCell({ inventory }: { inventory: Inventory }) {
  return <span className="text-muted-foreground">{inventory.product?.category?.name ?? '—'}</span>;
}

function PriceCell({ inventory }: { inventory: Inventory }) {
  if (inventory.product == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <MoneyDisplay amount={inventory.product.basePrice} size="sm" />;
}

function StatusCell({ inventory }: { inventory: Inventory }) {
  return <StatusBadge status={stockTier(inventory)} />;
}

function LowBadgeCell({ inventory }: { inventory: Inventory }) {
  const { t } = useTranslation('entities');
  if (!isLowStock(inventory)) return null;
  return (
    <Badge variant="destructive" className="ml-2 shrink-0 text-xs">
      {t('inventoryRow.low')}
    </Badge>
  );
}

function ThresholdCell({ inventory }: { inventory: Inventory }) {
  return <span className="tabular-nums">{inventory.lowStockThreshold}</span>;
}

function UnitCell({ inventory }: { inventory: Inventory }) {
  return <span className="text-muted-foreground">{inventory.unit}</span>;
}

function QuantityAdjustCell({
  inventory,
  currentRole,
}: {
  inventory: Inventory;
  currentRole: StaffRole | null | undefined;
}) {
  const adjust = useMutationAdjustInventory();
  const isThisRowPending = adjust.isPending && adjust.variables.productId === inventory.productId;

  const handleChange = (next: number) => {
    const delta = next - inventory.quantityOnHand;
    if (delta === 0) return;
    adjust.mutate(
      {
        productId: inventory.productId,
        quantityDelta: delta,
        reason: InventoryAdjustReason.MANUAL_ADJUSTMENT,
        notes: undefined,
      },
      {
        onSuccess: data => {
          if (!data.ok) {
            toast.error(data.error.message);
          }
        },
      }
    );
  };

  return (
    <div className="flex items-center gap-2">
      <ProtectedAction
        action="adjust_inventory"
        currentRole={currentRole}
        disabled={isThisRowPending}
      >
        <QuantityControl
          value={inventory.quantityOnHand}
          min={0}
          max={9999}
          onChange={handleChange}
        />
      </ProtectedAction>
    </div>
  );
}

export type InventoryRowProps = {
  inventory: Inventory;
  currentRole: StaffRole | null | undefined;
  className?: string;
};

/**
 * Full table row for inventory (use with `inventoryRowColumns` + DataTable for parity).
 */
export function InventoryRow({ inventory, currentRole, className }: InventoryRowProps) {
  return (
    <TableRow className={cn(className)}>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          <ProductCell inventory={inventory} />
          <LowBadgeCell inventory={inventory} />
        </div>
      </TableCell>
      <TableCell>
        <CategoryCell inventory={inventory} />
      </TableCell>
      <TableCell>
        <PriceCell inventory={inventory} />
      </TableCell>
      <TableCell>
        <StatusCell inventory={inventory} />
      </TableCell>
      <TableCell>
        <QuantityAdjustCell inventory={inventory} currentRole={currentRole} />
      </TableCell>
      <TableCell>
        <UnitCell inventory={inventory} />
      </TableCell>
      <TableCell>
        <ThresholdCell inventory={inventory} />
      </TableCell>
    </TableRow>
  );
}

/**
 * Column definitions for `DataTable` — matches `InventoryRow` layout.
 * `t` is the caller's `entities`-namespace TFunction (e.g. via
 * `useTranslation('entities')` or an explicit `'entities:...'`-prefixed key
 * off any other namespace's `t`) — this factory is a module-scope function,
 * not a component, so it cannot call the `useTranslation()` hook itself.
 */
/* eslint-disable react-refresh/only-export-components -- non-component export paired with entity row */
export function inventoryRowColumns(
  t: TFunction<'entities'>,
  currentRole: StaffRole | null | undefined
) {
  return [
    ch.accessor(row => row.product?.name ?? '', {
      id: 'productName',
      header: ({ column }) => (
        <SortHeader column={column} title={t('inventoryRow.columns.product')} />
      ),
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-1">
          <ProductCell inventory={row.original} />
          <LowBadgeCell inventory={row.original} />
        </div>
      ),
      sortingFn: 'alphanumeric',
    }),
    ch.accessor(row => row.product?.category?.name ?? '', {
      id: 'categoryName',
      header: ({ column }) => (
        <SortHeader column={column} title={t('inventoryRow.columns.category')} />
      ),
      cell: ({ row }) => <CategoryCell inventory={row.original} />,
      filterFn: (row, _columnId, filterValue: string) => {
        if (!filterValue || filterValue === '__all__') return true;
        return (row.original.product?.category?.name ?? '') === filterValue;
      },
      sortingFn: 'alphanumeric',
    }),
    ch.display({
      id: 'basePrice',
      header: t('inventoryRow.columns.price'),
      cell: ({ row }) => <PriceCell inventory={row.original} />,
    }),
    ch.display({
      id: 'stockStatus',
      header: t('inventoryRow.columns.status'),
      cell: ({ row }) => <StatusCell inventory={row.original} />,
    }),
    ch.accessor('quantityOnHand', {
      id: 'quantityOnHand',
      header: ({ column }) => (
        <SortHeader column={column} title={t('inventoryRow.columns.onHand')} />
      ),
      cell: ({ row }) => <QuantityAdjustCell inventory={row.original} currentRole={currentRole} />,
      sortingFn: 'basic',
    }),
    ch.accessor('unit', {
      header: ({ column }) => <SortHeader column={column} title={t('inventoryRow.columns.unit')} />,
      cell: ({ row }) => <UnitCell inventory={row.original} />,
      sortingFn: 'alphanumeric',
    }),
    ch.accessor('lowStockThreshold', {
      header: ({ column }) => (
        <SortHeader column={column} title={t('inventoryRow.columns.threshold')} />
      ),
      cell: ({ row }) => <ThresholdCell inventory={row.original} />,
      sortingFn: 'basic',
    }),
  ];
}
