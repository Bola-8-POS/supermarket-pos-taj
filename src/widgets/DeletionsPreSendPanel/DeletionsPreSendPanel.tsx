import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportButtons } from '@features/export-report';
import { useDeletionsPreReport } from '@entities/tab/model/queries-reports';
import type { DeletionsPreRow } from '@shared/lib/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  DataTable,
  EmptyState,
  LoadingSpinner,
} from '@shared/ui';
import { EntityIdCell } from '@shared/ui/EntityIdCell';

type Props = {
  dateRange: { from: Date; to: Date };
};

function buildColumns(t: TFunction<'wAdmin'>): ColumnDef<DeletionsPreRow>[] {
  return [
    {
      accessorKey: 'orderId',
      header: t('deletionsPreSendPanel.columnOrderId'),
      // "order_item" is not in EntityIdCell's LINKABLE_TYPES allowlist —
      // renders copy-only plain text, no /order-items/:id route exists or
      // is invented for it.
      // eslint-disable-next-line i18next/no-literal-string -- EntityType domain identifier, not UI copy
      cell: info => <EntityIdCell entityType="order_item" entityId={info.getValue<string>()} />,
    },
    {
      accessorKey: 'itemName',
      header: t('deletionsPreSendPanel.columnItemName'),
    },
    {
      accessorKey: 'removedAt',
      header: t('deletionsPreSendPanel.columnRemovedAt'),
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
      header: t('deletionsPreSendPanel.columnStaffName'),
      cell: info => <span className="font-medium">{info.getValue<string>()}</span>,
    },
    {
      accessorKey: 'reason',
      header: t('deletionsPreSendPanel.columnReason'),
      cell: info => (
        <span className="max-w-xs truncate text-muted-foreground">
          {info.getValue<string>() || '—'}
        </span>
      ),
    },
  ];
}

export function DeletionsPreSendPanel({ dateRange }: Props) {
  const { t } = useTranslation('wAdmin');
  const { data: result, isLoading } = useDeletionsPreReport(dateRange.from, dateRange.to);

  const rows = useMemo(() => (result?.ok ? result.data : []), [result]);
  const columns = useMemo(() => buildColumns(t), [t]);

  const exportData = { rows, dateRange };

  const toolbar =
    rows.length > 0 ? <ExportButtons reportType="deletions-pre" data={exportData} /> : null;

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-4">
      <Alert variant="default">
        <AlertTriangle />
        <AlertTitle>{t('deletionsPreSendPanel.historicalGapTitle')}</AlertTitle>
        <AlertDescription>{t('deletionsPreSendPanel.historicalGapDescription')}</AlertDescription>
      </Alert>
      <DataTable
        columns={columns}
        data={rows}
        toolbar={toolbar}
        emptyState={
          <EmptyState
            icon={AlertTriangle}
            title={t('deletionsPreSendPanel.emptyTitle')}
            description={t('deletionsPreSendPanel.emptyDescription')}
          />
        }
      />
    </div>
  );
}
