import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import { useDeletionsPostReport } from '@entities/tab/model/queries-reports';
import type { DeletionsPostRow } from '@shared/lib/domain';
import { DataTable, EmptyState, LoadingSpinner } from '@shared/ui';
import { EntityIdCell } from '@shared/ui/EntityIdCell';

type Props = {
  dateRange: { from: Date; to: Date };
};

function buildColumns(t: TFunction<'wAdmin'>): ColumnDef<DeletionsPostRow>[] {
  return [
    {
      accessorKey: 'tabId',
      header: t('deletionsPostCloseReport.columnTabId'),
      // eslint-disable-next-line i18next/no-literal-string -- EntityType domain identifier, not UI copy
      cell: info => <EntityIdCell entityType="tab" entityId={info.getValue<string>()} />,
    },
    {
      accessorKey: 'editedAt',
      header: t('deletionsPostCloseReport.columnEditedAt'),
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
      header: t('deletionsPostCloseReport.columnStaffName'),
      cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
    },
    {
      accessorKey: 'reason',
      header: t('deletionsPostCloseReport.columnReason'),
      cell: info => (
        <span className="max-w-xs truncate text-muted-foreground">
          {info.getValue<string>() || '—'}
        </span>
      ),
    },
    {
      accessorKey: 'fieldsChanged',
      header: t('deletionsPostCloseReport.columnFieldsChanged'),
      cell: info => info.getValue<string[]>().join(', '),
    },
  ];
}

export function DeletionsPostCloseReport({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useDeletionsPostReport(dateRange.from, dateRange.to);

  const rows = useMemo(() => (result?.ok ? result.data : []), [result]);
  const columns = useMemo(() => buildColumns(t), [t]);

  const exportData = { rows, dateRange };

  const toolbar =
    rows.length > 0 ? <ExportButtons reportType="deletions-post" data={exportData} /> : null;

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={rows}
        toolbar={toolbar}
        emptyState={
          <EmptyState
            icon={AlertTriangle}
            title={t('deletionsPostCloseReport.emptyTitle')}
            description={t('deletionsPostCloseReport.emptyDescription')}
          />
        }
      />
    </div>
  );
}
