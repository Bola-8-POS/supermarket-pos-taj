import type { ColumnDef } from '@tanstack/react-table';
import { Users } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import { useStaffMetrics } from '@entities/staff';
import type { StaffMetric } from '@shared/lib/domain';
import { DataTable, EmptyState, LoadingSpinner, MoneyDisplay } from '@shared/ui';

type Props = { dateRange: { from: Date; to: Date } };

export function StaffSalesPanel({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useStaffMetrics(dateRange.from, dateRange.to);
  const rows = useMemo(() => (result?.ok ? result.data : []), [result]);

  const columns: ColumnDef<StaffMetric>[] = useMemo(
    () => [
      {
        accessorKey: 'staffName',
        header: t('staffSalesPanel.columnStaffMember'),
        cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
      },
      {
        accessorKey: 'revenue',
        header: t('staffSalesPanel.columnRevenue'),
        cell: info => <MoneyDisplay amount={info.getValue<number>()} size="sm" />,
      },
      {
        accessorKey: 'transactionCount',
        header: t('staffSalesPanel.columnTransactions'),
        cell: info => <span className="tabular-nums">{info.getValue<number>()}</span>,
      },
      {
        accessorKey: 'avgCheckSize',
        header: t('staffSalesPanel.columnAvgCheck'),
        cell: info => <MoneyDisplay amount={info.getValue<number>()} size="sm" />,
      },
      {
        accessorKey: 'voidCount',
        header: t('staffSalesPanel.columnVoids'),
        cell: info => (
          <span className="tabular-nums text-muted-foreground">{info.getValue<number>()}</span>
        ),
      },
    ],
    [t]
  );

  const toolbar =
    rows.length > 0 ? <ExportButtons reportType="staff" data={{ rows, dateRange }} /> : null;

  if (isLoading) return <LoadingSpinner />;

  return (
    <DataTable
      columns={columns}
      data={rows}
      toolbar={toolbar}
      emptyState={
        <EmptyState
          icon={Users}
          title={t('staffSalesPanel.emptyTitle')}
          description={t('staffSalesPanel.emptyDescription')}
        />
      }
    />
  );
}
