/**
 * RefundsList widget
 *
 * Read-only DataTable of all processed refunds.
 * Rendered on the Refunds tab of PaymentsPage.
 */
import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { ReceiptText } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useRefunds } from '@entities/refund';
import type { Refund } from '@shared/lib/domain';
import { DataTable } from '@shared/ui/DataTable';
import { EmptyState } from '@shared/ui/EmptyState';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { Badge } from '@shared/ui/badge';

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function capitalizeReason(reason: string): string {
  return reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildColumns(t: TFunction<'wAdmin'>): ColumnDef<Refund>[] {
  return [
    {
      id: 'created_at',
      accessorKey: 'createdAt',
      header: t('refundsList.columnDate'),
      cell: ({ row }) => (
        <span className="font-mono text-sm text-muted-foreground">
          {formatDate(row.original.createdAt)}
        </span>
      ),
    },
    {
      id: 'original_payment_id',
      accessorKey: 'originalPaymentId',
      header: t('refundsList.columnPaymentRef'),
      cell: ({ row }) => (
        <span className="font-mono text-sm text-muted-foreground">
          {t('refundsList.truncatedId', { id: row.original.originalPaymentId.slice(0, 8) })}
        </span>
      ),
    },
    {
      id: 'reason',
      accessorKey: 'reason',
      header: t('refundsList.columnReason'),
      cell: ({ row }) => <span className="text-sm">{capitalizeReason(row.original.reason)}</span>,
    },
    {
      id: 'items_count',
      header: t('refundsList.columnItems'),
      cell: ({ row }) => (
        <span className="text-sm">
          {t('refundsList.itemsCount', { itemCount: row.original.items.length })}
        </span>
      ),
    },
    {
      id: 'amount',
      accessorKey: 'amount',
      header: t('refundsList.columnAmount'),
      enableSorting: true,
      cell: ({ row }) => <MoneyDisplay amount={row.original.amount} size="sm" negative={true} />,
    },
    {
      id: 'restocked',
      header: t('refundsList.columnRestocked'),
      cell: ({ row }) => {
        const hasRestock = row.original.items.some(i => i.restock);
        return hasRestock ? (
          <Badge variant="outline" className="text-success-strong border-success">
            {t('refundsList.yes')}
          </Badge>
        ) : (
          <Badge variant="outline">{t('refundsList.no')}</Badge>
        );
      },
    },
    {
      id: 'created_by',
      header: t('refundsList.columnStaff'),
      cell: ({ row }) => (
        <span className="font-mono text-sm text-muted-foreground">
          {t('refundsList.truncatedId', { id: row.original.createdBy.slice(0, 8) })}
        </span>
      ),
    },
  ];
}

export function RefundsList() {
  const { t } = useTranslation('wAdmin');
  const { data: refunds, isLoading } = useRefunds();
  const columns = useMemo(() => buildColumns(t), [t]);

  return (
    <DataTable
      columns={columns}
      data={refunds ?? []}
      isLoading={isLoading}
      enableSorting
      initialSorting={[{ id: 'created_at', desc: true }]}
      searchable={false}
      emptyState={
        <EmptyState
          icon={ReceiptText}
          title={t('refundsList.emptyTitle')}
          description={t('refundsList.emptyDescription')}
        />
      }
    />
  );
}
