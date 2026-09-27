import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import { useVoidRefundReport, type VoidRefundRow } from '@entities/tab/model/queries-reports';
import { DataTable, EmptyState, LoadingSpinner, MoneyDisplay } from '@shared/ui';

type Props = {
  dateRange: { from: Date; to: Date };
};

function buildColumns(t: TFunction<'wAdmin'>): ColumnDef<VoidRefundRow>[] {
  return [
    {
      accessorKey: 'voidedAt',
      header: t('voidRefundPanel.columnTimestamp'),
      cell: info =>
        info.getValue<Date>().toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
    },
    {
      accessorKey: 'staffName',
      header: t('voidRefundPanel.columnStaff'),
      cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
    },
    {
      accessorKey: 'amount',
      header: t('voidRefundPanel.columnAmount'),
      cell: info => <MoneyDisplay amount={info.getValue<number>()} size="sm" />,
    },
    {
      accessorKey: 'reason',
      header: t('voidRefundPanel.columnReason'),
      cell: info => (
        <span className="max-w-xs truncate text-muted-foreground">
          {info.getValue<string>() || '—'}
        </span>
      ),
    },
  ];
}

export function VoidRefundPanel({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useVoidRefundReport(dateRange.from, dateRange.to);

  const rows = useMemo(() => (result?.ok ? result.data : []), [result]);
  const columns = useMemo(() => buildColumns(t), [t]);

  const exportData = { rows, dateRange };

  const toolbar = rows.length > 0 ? <ExportButtons reportType="voids" data={exportData} /> : null;

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <DataTable
      columns={columns}
      data={rows}
      toolbar={toolbar}
      emptyState={
        <EmptyState
          icon={AlertTriangle}
          title={t('voidRefundPanel.emptyTitle')}
          description={t('voidRefundPanel.emptyDescription')}
        />
      }
    />
  );
}
