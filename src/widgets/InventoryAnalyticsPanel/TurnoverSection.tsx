import type { ColumnDef } from '@tanstack/react-table';
import { Repeat } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import {
  combineTurnoverRows,
  useTurnoverReport,
  type TurnoverRow,
} from '@entities/inventory/model/queries-analytics';
import { useProductSalesReport } from '@entities/tab/model/queries-reports';
import { DataTable, EmptyState, LoadingSpinner, MoneyDisplay, SectionHeader } from '@shared/ui';

type Props = {
  dateRange: { from: Date; to: Date };
};

/**
 * Turnover/Sell-through (INVR-04): combines useProductSalesReport (units
 * sold, reused verbatim — imported directly here, never re-implemented) with
 * useTurnoverReport's two-point average of computeInventoryValueAsOf (D-04,
 * shared with Valuation) via the pure combineTurnoverRows fn. Composed in
 * this component layer (two sibling useQuery hooks) rather than nesting a
 * hook call inside a third queryFn, per 14-RESEARCH.md's Open Question #1.
 */
export function TurnoverSection({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: salesResult, isLoading: isSalesLoading } = useProductSalesReport(
    dateRange.from,
    dateRange.to
  );
  const { data: valuationResult, isLoading: isValuationLoading } = useTurnoverReport(
    dateRange.from,
    dateRange.to
  );

  const isLoading = isSalesLoading || isValuationLoading;
  const hasError = Boolean(
    (salesResult && !salesResult.ok) || (valuationResult && !valuationResult.ok)
  );

  const rows = useMemo(() => {
    if (!salesResult?.ok || !valuationResult?.ok) return [];
    const salesRows = salesResult.data.map(r => ({
      productId: r.productId,
      productName: r.productName,
      categoryName: r.categoryName,
      units: r.units,
    }));
    return combineTurnoverRows(
      salesRows,
      valuationResult.data.valueAtFrom,
      valuationResult.data.valueAtTo
    );
  }, [salesResult, valuationResult]);

  const columns: ColumnDef<TurnoverRow>[] = useMemo(
    () => [
      {
        accessorKey: 'productName',
        header: t('turnoverSection.columnProduct'),
        cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
      },
      {
        accessorKey: 'categoryName',
        header: t('turnoverSection.columnCategory'),
      },
      {
        accessorKey: 'unitsSold',
        header: t('turnoverSection.columnUnitsSold'),
        cell: info => {
          const value = info.getValue<number | null>();
          return value !== null ? (
            <span className="tabular-nums">{value}</span>
          ) : (
            <span
              className="text-sm text-muted-foreground"
              aria-label={t('turnoverSection.unitsUnavailableAriaLabel')}
            >
              —
            </span>
          );
        },
      },
      {
        accessorKey: 'avgValue',
        header: t('turnoverSection.columnAvgValue'),
        cell: info => {
          const value = info.getValue<number | null>();
          return value !== null ? (
            <MoneyDisplay amount={value} size="sm" />
          ) : (
            <span
              className="text-sm text-muted-foreground"
              aria-label={t('turnoverSection.avgValueUnavailableAriaLabel')}
            >
              —
            </span>
          );
        },
      },
      {
        accessorKey: 'turnoverRatio',
        header: t('turnoverSection.columnTurnoverRatio'),
        cell: info => {
          const value = info.getValue<number | null>();
          return value !== null ? (
            // eslint-disable-next-line no-restricted-syntax -- unitless ratio (units sold / avg inventory value), not a money amount
            <span className="tabular-nums">{value.toFixed(2)}</span>
          ) : (
            <span
              className="text-sm text-muted-foreground"
              aria-label={t('turnoverSection.turnoverRatioUnavailableAriaLabel')}
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
  } else if (hasError) {
    content = (
      <p className="text-sm text-destructive" role="alert">
        {t('turnoverSection.errorMessage')}
      </p>
    );
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={Repeat}
        title={t('turnoverSection.emptyTitle')}
        description={t('turnoverSection.emptyDescription')}
      />
    );
  } else {
    content = (
      <div className="space-y-4">
        <p className="max-w-2xl whitespace-normal text-sm text-muted-foreground">
          {t('turnoverSection.formulaNote', {
            fromDate: dateRange.from.toLocaleDateString(),
            toDate: dateRange.to.toLocaleDateString(),
          })}
        </p>

        <DataTable
          columns={columns}
          data={rows}
          toolbar={
            rows.length > 0 ? (
              <ExportButtons reportType="turnover" data={{ rows, dateRange }} />
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="turnover-section">
      <SectionHeader title={t('turnoverSection.title')} />
      {content}
    </div>
  );
}
