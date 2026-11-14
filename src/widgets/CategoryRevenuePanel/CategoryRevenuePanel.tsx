import { PieChart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import {
  useCategoryRevenueReport,
  type CategoryRevenueRow,
} from '@entities/tab/model/queries-reports';
import { EmptyState, LoadingSpinner, MoneyDisplay } from '@shared/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@shared/ui/table';

type Props = {
  dateRange: { from: Date; to: Date };
};

export function CategoryRevenuePanel({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useCategoryRevenueReport(dateRange.from, dateRange.to);

  if (isLoading) return <LoadingSpinner />;

  const rows: CategoryRevenueRow[] = result?.ok ? result.data : [];

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={PieChart}
        title={t('categoryRevenuePanel.emptyTitle')}
        description={t('categoryRevenuePanel.emptyDescription')}
      />
    );
  }

  const exportData = { rows, dateRange };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ExportButtons reportType="categories" data={exportData} />
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('categoryRevenuePanel.columnCategory')}</TableHead>
              <TableHead>{t('categoryRevenuePanel.columnUnitsSold')}</TableHead>
              <TableHead>{t('categoryRevenuePanel.columnOrders')}</TableHead>
              <TableHead>{t('categoryRevenuePanel.columnRevenue')}</TableHead>
              <TableHead>{t('categoryRevenuePanel.columnPctTotal')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, idx) => (
              <TableRow
                key={row.categoryId}
                className={idx === 0 ? 'border-l-2 border-l-brand bg-brand-soft/60' : undefined}
              >
                <TableCell className="font-medium">{row.categoryName}</TableCell>
                <TableCell className="tabular-nums">{row.unitsSold}</TableCell>
                <TableCell className="tabular-nums">{row.orderCount}</TableCell>
                <TableCell>
                  <MoneyDisplay amount={row.revenue} size="sm" />
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {row.pctTotal}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
