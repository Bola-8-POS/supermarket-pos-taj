import type { ColumnDef } from '@tanstack/react-table';
import { BarChart2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import { useProductSalesReport, type ProductSalesRow } from '@entities/tab/model/queries-reports';
import { DataTable, EmptyState, LoadingSpinner, MoneyDisplay, POSButton } from '@shared/ui';

type Props = {
  dateRange: { from: Date; to: Date };
};

const ALL_CATEGORIES = 'All';

export function ProductSalesPanel({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useProductSalesReport(dateRange.from, dateRange.to);

  const rawRows = useMemo(() => (result?.ok ? result.data : []), [result]);

  // Unique categories for filter
  const categories = useMemo(() => {
    const set = new Set(rawRows.map(r => r.categoryName));
    return [ALL_CATEGORIES, ...Array.from(set).sort()];
  }, [rawRows]);

  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_CATEGORIES);
  const [sortBy, setSortBy] = useState<'revenue' | 'units'>('revenue');

  const filtered = useMemo(() => {
    let out =
      selectedCategory === ALL_CATEGORIES
        ? rawRows
        : rawRows.filter(r => r.categoryName === selectedCategory);

    if (sortBy === 'units') {
      out = [...out].sort((a, b) => b.units - a.units);
    } else {
      out = [...out].sort((a, b) => b.revenue - a.revenue);
    }
    return out;
  }, [rawRows, selectedCategory, sortBy]);

  const columns: ColumnDef<ProductSalesRow>[] = useMemo(
    () => [
      {
        accessorKey: 'productName',
        header: t('productSalesPanel.columnProduct'),
        cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
      },
      {
        accessorKey: 'categoryName',
        header: t('productSalesPanel.columnCategory'),
      },
      {
        accessorKey: 'units',
        header: t('productSalesPanel.columnUnitsSold'),
        cell: info => <span className="tabular-nums">{info.getValue<number>()}</span>,
      },
      {
        accessorKey: 'revenue',
        header: t('productSalesPanel.columnRevenue'),
        cell: info => <MoneyDisplay amount={info.getValue<number>()} size="sm" />,
      },
      {
        accessorKey: 'pctTotal',
        header: t('productSalesPanel.columnPctTotal'),
        cell: info => (
          <span className="tabular-nums text-muted-foreground">{info.getValue<number>()}%</span>
        ),
      },
      {
        accessorKey: 'margin',
        header: t('productSalesPanel.columnMargin'),
        cell: info => {
          const margin = info.getValue<number | null>();
          return margin !== null ? (
            <MoneyDisplay amount={margin} size="sm" />
          ) : (
            <span
              className="text-muted-foreground text-sm"
              aria-label={t('productSalesPanel.marginUnavailableAriaLabel')}
            >
              —
            </span>
          );
        },
      },
    ],
    [t]
  );

  const exportData = { rows: filtered, dateRange };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="h-11 rounded-lg border border-input bg-card px-2 shadow-xs dark:bg-input/20 py-1 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
        value={selectedCategory}
        onChange={e => {
          setSelectedCategory(e.target.value);
        }}
        aria-label={t('productSalesPanel.filterByCategoryAriaLabel')}
      >
        {categories.map(cat => (
          <option key={cat} value={cat}>
            {cat}
          </option>
        ))}
      </select>

      <div className="flex gap-1">
        <POSButton
          type="button"
          variant="outline"
          touchSize="default"
          onClick={() => {
            setSortBy('revenue');
          }}
          className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
            sortBy === 'revenue'
              ? 'bg-primary text-primary-foreground'
              : 'border border-input bg-card text-foreground shadow-xs hover:bg-muted'
          }`}
        >
          {t('productSalesPanel.sortByRevenue')}
        </POSButton>
        <POSButton
          type="button"
          variant="outline"
          touchSize="default"
          onClick={() => {
            setSortBy('units');
          }}
          className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
            sortBy === 'units'
              ? 'bg-primary text-primary-foreground'
              : 'border border-input bg-card text-foreground shadow-xs hover:bg-muted'
          }`}
        >
          {t('productSalesPanel.sortByUnits')}
        </POSButton>
      </div>

      {rawRows.length > 0 && <ExportButtons reportType="products" data={exportData} />}
    </div>
  );

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <DataTable
      columns={columns}
      data={filtered}
      toolbar={toolbar}
      emptyState={
        <EmptyState
          icon={BarChart2}
          title={t('productSalesPanel.emptyTitle')}
          description={t('productSalesPanel.emptyDescription')}
        />
      }
      getRowClassName={(row: ProductSalesRow) => {
        const idx = filtered.indexOf(row);
        if (idx < 3 && filtered.length > 0) {
          // eslint-disable-next-line i18next/no-literal-string -- Tailwind class string, not UI copy
          return 'border-l-2 border-l-brand bg-brand-soft/60';
        }
        return undefined;
      }}
    />
  );
}
