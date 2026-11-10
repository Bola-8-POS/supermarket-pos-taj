import type { ColumnDef } from '@tanstack/react-table';
import { PackageX } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import {
  useInventoryValuationReport,
  type ValuationRow,
} from '@entities/inventory/model/queries-analytics';
import {
  DataTable,
  EmptyState,
  LoadingSpinner,
  MoneyDisplay,
  SectionHeader,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@shared/ui';

type Props = {
  dateRange: { from: Date; to: Date };
};

export function ValuationSection({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  // D-05: Valuation reads the shared date range as "as of end date" only —
  // `dateRange.from` is intentionally never consulted here.
  const { data: result, isLoading } = useInventoryValuationReport(dateRange.to);

  const rows = useMemo(() => (result?.ok ? result.data : []), [result]);

  // Sorted by value descending (nulls last) so the top-3-by-value highlight
  // and the rendered row order agree, mirroring ProductSalesPanel's pattern.
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity)),
    [rows]
  );

  const storeTotal = useMemo(() => rows.reduce((sum, r) => sum + (r.value ?? 0), 0), [rows]);

  const categorySubtotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.categoryName, (map.get(r.categoryName) ?? 0) + (r.value ?? 0));
    }
    return Array.from(map.entries());
  }, [rows]);

  const columns: ColumnDef<ValuationRow>[] = useMemo(
    () => [
      {
        accessorKey: 'productName',
        header: t('valuationSection.columnProduct'),
        cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
      },
      {
        accessorKey: 'categoryName',
        header: t('valuationSection.columnCategory'),
      },
      {
        accessorKey: 'quantityAsOf',
        header: t('valuationSection.columnQuantity'),
        cell: info => <span className="tabular-nums">{info.getValue<number>()}</span>,
      },
      {
        accessorKey: 'costPrice',
        header: t('valuationSection.columnCostPrice'),
        cell: info => {
          const cost = info.getValue<number | null>();
          return cost !== null ? (
            <MoneyDisplay amount={cost} size="sm" />
          ) : (
            <span
              className="text-sm text-muted-foreground"
              aria-label={t('valuationSection.costUnavailableAriaLabel')}
            >
              —
            </span>
          );
        },
      },
      {
        accessorKey: 'value',
        header: t('valuationSection.columnValue'),
        cell: info => {
          const value = info.getValue<number | null>();
          return value !== null ? (
            <MoneyDisplay amount={value} size="sm" />
          ) : (
            <span
              className="text-sm text-muted-foreground"
              aria-label={t('valuationSection.costUnavailableAriaLabel')}
            >
              —
            </span>
          );
        },
      },
    ],
    [t]
  );

  let content: ReactNode;
  if (isLoading) {
    content = <LoadingSpinner />;
  } else if (!result?.ok) {
    content = (
      <p className="text-sm text-destructive" role="alert">
        {t('valuationSection.errorMessage')}
      </p>
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={PackageX}
        title={t('valuationSection.emptyTitle')}
        description={t('valuationSection.emptyDescription')}
      />
    );
  } else {
    content = (
      <div className="space-y-4">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {t('valuationSection.storeTotalLabel')}
          </div>
          <MoneyDisplay amount={storeTotal} size="xl" className="font-semibold" />
        </div>

        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {t('valuationSection.categorySubtotalLabel')}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {categorySubtotals.map(([categoryName, subtotal]) => (
              <div key={categoryName} className="rounded-lg border bg-card px-4 py-3 text-center">
                <div className="text-xs text-muted-foreground">{categoryName}</div>
                <MoneyDisplay amount={subtotal} size="md" />
              </div>
            ))}
          </div>
        </div>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="max-w-2xl whitespace-normal text-sm text-muted-foreground">
                {t('valuationSection.formulaNote', {
                  toDate: dateRange.to.toLocaleDateString(),
                })}
              </p>
            </TooltipTrigger>
            <TooltipContent>{t('valuationSection.formulaTooltip')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <DataTable
          columns={columns}
          data={sortedRows}
          toolbar={
            rows.length > 0 ? (
              <ExportButtons reportType="valuation" data={{ rows: sortedRows, dateRange }} />
            ) : undefined
          }
          getRowClassName={(row: ValuationRow) => {
            const idx = sortedRows.indexOf(row);
            if (idx < 3 && sortedRows.length > 0) {
              // eslint-disable-next-line i18next/no-literal-string -- Tailwind class string, not UI copy
              return 'border-l-2 border-l-brand bg-brand-soft/60';
            }
            return undefined;
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="valuation-section">
      <SectionHeader title={t('valuationSection.title')} />
      {content}
    </div>
  );
}
