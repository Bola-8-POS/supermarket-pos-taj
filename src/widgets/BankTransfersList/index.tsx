/**
 * BankTransfersList widget
 *
 * DataTable of bank-transfer sales (pending/confirmed/disputed) with a
 * status-filter toolbar and manager+-gated Confirm/Dispute row actions.
 * Rendered on the Bank Transfers tab of PaymentsPage (D-11: not a new route).
 */
import type { ColumnDef } from '@tanstack/react-table';
import type { TFunction } from 'i18next';
import { Download, Landmark } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmTransferDialog, DisputeTransferDialog } from '@features/confirm-dispute-transfer';
import { useExportBankTransfersCsv } from '@features/export-bank-transfers/model/useExportBankTransfersCsv';
import { useAllTransfers } from '@entities/bank-transfer';
import type { BankTransfer, BankTransferStatus } from '@entities/bank-transfer';
import { useStaffStore } from '@entities/staff/model/store';
import { canAccess } from '@shared/lib/rbac';
import { cn } from '@shared/lib/utils';
import { DataTable } from '@shared/ui/DataTable';
import { EmptyState } from '@shared/ui/EmptyState';
import { LockedFeature } from '@shared/ui/LockedFeature';
import { MoneyDisplay } from '@shared/ui/MoneyDisplay';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';

// D-17: a hardcoded staleness threshold, not a Settings toggle.
const STALE_PENDING_THRESHOLD_MS = 8 * 60 * 60 * 1000;

const STATUS_FILTERS = ['pending', 'confirmed', 'disputed', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function isStale(transfer: BankTransfer): boolean {
  return (
    transfer.status === 'pending' &&
    Date.now() - transfer.createdAt.getTime() > STALE_PENDING_THRESHOLD_MS
  );
}

function formatElapsed(createdAt: Date, t: TFunction<'wAdmin'>): string {
  const ms = Date.now() - createdAt.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return t('bankTransfersList.elapsedMinutes', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t('bankTransfersList.elapsedHours', { count: hours });
  }
  const days = Math.floor(hours / 24);
  return t('bankTransfersList.elapsedDays', { count: days });
}

function statusBadgeVariant(status: BankTransferStatus): 'outline' | 'secondary' | 'destructive' {
  if (status === 'confirmed') return 'secondary';
  if (status === 'disputed') return 'destructive';
  return 'outline';
}

function rowHighlightClass(transfer: BankTransfer): string | undefined {
  // eslint-disable-next-line i18next/no-literal-string -- Tailwind class string, not UI copy
  return isStale(transfer) ? 'border-l-2 border-l-warning bg-warning-soft/60' : undefined;
}

function buildColumns(
  t: TFunction<'wAdmin'>,
  canConfirm: boolean,
  canDispute: boolean,
  onConfirm: (transfer: BankTransfer) => void,
  onDispute: (transfer: BankTransfer) => void
): ColumnDef<BankTransfer>[] {
  return [
    {
      id: 'reference_code',
      accessorKey: 'referenceCode',
      header: t('bankTransfersList.columnReference'),
      cell: ({ row }) => (
        <Badge variant="outline" className="font-mono">
          {row.original.referenceCode}
        </Badge>
      ),
    },
    {
      id: 'customer',
      header: t('bankTransfersList.columnCustomer'),
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="text-sm font-medium">{row.original.customerName}</span>
          {row.original.customerPhone && (
            <span className="text-xs text-muted-foreground">{row.original.customerPhone}</span>
          )}
        </div>
      ),
    },
    {
      id: 'amount',
      accessorKey: 'amount',
      header: t('bankTransfersList.columnAmount'),
      enableSorting: true,
      cell: ({ row }) => <MoneyDisplay amount={row.original.amount} size="sm" />,
    },
    {
      id: 'elapsed',
      accessorKey: 'createdAt',
      header: t('bankTransfersList.columnElapsed'),
      enableSorting: true,
      cell: ({ row }) => (
        <span
          className={cn(
            'font-mono text-sm',
            isStale(row.original) ? 'font-semibold text-warning-strong' : 'text-muted-foreground'
          )}
        >
          {formatElapsed(row.original.createdAt, t)}
        </span>
      ),
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: t('bankTransfersList.columnStatus'),
      cell: ({ row }) => {
        const { status } = row.original;
        return (
          <Badge variant={statusBadgeVariant(status)}>
            {t(`bankTransfersList.status.${status}`)}
          </Badge>
        );
      },
    },
    {
      id: 'resolution',
      header: t('bankTransfersList.columnActions'),
      cell: ({ row }) => {
        const transfer = row.original;
        if (transfer.status === 'confirmed') {
          return (
            <span className="text-sm text-muted-foreground">
              {t('bankTransfersList.confirmedBy', { name: transfer.confirmedByName ?? '' })}
            </span>
          );
        }
        if (transfer.status === 'disputed') {
          return (
            <span className="text-sm text-muted-foreground">
              {transfer.disputeReason ??
                t('bankTransfersList.disputedBy', { name: transfer.disputedByName ?? '' })}
            </span>
          );
        }
        return (
          <div className="flex gap-2">
            {canConfirm && (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onConfirm(transfer);
                }}
              >
                {t('bankTransfersList.confirmAction')}
              </Button>
            )}
            {canDispute && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onDispute(transfer);
                }}
              >
                {t('bankTransfersList.disputeAction')}
              </Button>
            )}
          </div>
        );
      },
    },
  ];
}

export function BankTransfersList() {
  const { t } = useTranslation('wAdmin');
  const { data: transfers, isLoading } = useAllTransfers();
  const role = useStaffStore(s => s.currentStaff?.role);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [confirmTarget, setConfirmTarget] = useState<BankTransfer | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<BankTransfer | null>(null);
  const { exportBankTransfersCsv, isExporting } = useExportBankTransfersCsv();

  const canConfirm = canAccess(role, 'confirm_transfer_payment');
  const canDispute = canAccess(role, 'dispute_transfer_payment');

  const filteredRows = useMemo(() => {
    const rows = transfers ?? [];
    if (statusFilter === 'all') return rows;
    return rows.filter(r => r.status === statusFilter);
  }, [transfers, statusFilter]);

  // Export always covers pending+confirmed regardless of the active toolbar
  // filter (D-13) — the filter only changes what's on screen.
  const exportableRows = useMemo(
    () => (transfers ?? []).filter(r => r.status !== 'disputed'),
    [transfers]
  );

  const columns = useMemo(
    () =>
      buildColumns(
        t,
        canConfirm,
        canDispute,
        transfer => {
          setConfirmTarget(transfer);
        },
        transfer => {
          setDisputeTarget(transfer);
        }
      ),
    [t, canConfirm, canDispute]
  );

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map(filter => (
          <Button
            key={filter}
            type="button"
            size="sm"
            variant={statusFilter === filter ? 'default' : 'outline'}
            onClick={() => {
              setStatusFilter(filter);
            }}
          >
            {filter === 'all'
              ? t('bankTransfersList.filterAll')
              : t(`bankTransfersList.status.${filter}`)}
          </Button>
        ))}
      </div>
      <LockedFeature feature="report_export">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={exportableRows.length === 0 || isExporting}
          onClick={() => {
            void exportBankTransfersCsv(exportableRows);
          }}
        >
          <Download className="mr-1.5 size-4" />
          {t('bankTransfersList.exportCsvButton')}
        </Button>
      </LockedFeature>
    </div>
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={filteredRows}
        isLoading={isLoading}
        enableSorting
        initialSorting={[{ id: 'elapsed', desc: false }]}
        searchable={false}
        toolbar={toolbar}
        getRowClassName={rowHighlightClass}
        emptyState={
          <EmptyState
            icon={Landmark}
            title={t('bankTransfersList.emptyTitle')}
            description={t('bankTransfersList.emptyDescription')}
          />
        }
      />
      <ConfirmTransferDialog
        open={confirmTarget !== null}
        transfer={confirmTarget}
        onOpenChange={open => {
          if (!open) setConfirmTarget(null);
        }}
      />
      <DisputeTransferDialog
        open={disputeTarget !== null}
        transfer={disputeTarget}
        onOpenChange={open => {
          if (!open) setDisputeTarget(null);
        }}
      />
    </>
  );
}
