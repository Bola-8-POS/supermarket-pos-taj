/**
 * PrintJobsTable — composite widget for the `/audit` page's "Print Jobs"
 * tab. Structurally mirrors AuditLogTable (same DataTable + staged-filter-
 * then-Apply + click-row-opens-Sheet composition), but reads from
 * entities/print-job (Plan 19-06, broker-backed) instead of Supabase-backed
 * entities/audit-log, and shows an event timeline instead of a JSON diff.
 */
import type { ColumnDef } from '@tanstack/react-table';
import { Loader2, Printer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePrintJob, usePrintJobs } from '@entities/print-job';
import type { PrintJob, PrintJobFilters } from '@entities/print-job';
import { DataTable } from '@shared/ui/DataTable';
import { EmptyState } from '@shared/ui/EmptyState';
import { EntityIdCell } from '@shared/ui/EntityIdCell';
import { POSButton } from '@shared/ui/POSButton';
import { PrintJobStatusBadge } from '@shared/ui/PrintJobStatusBadge';
import { Button } from '@shared/ui/button';

import { PrintJobDetailSheet } from './PrintJobDetailSheet';
import { PrintJobFilterBar } from './PrintJobFilterBar';

function formatDate(date: Date): string {
  return date.toLocaleString();
}

function hasAnyFilter(filters: PrintJobFilters): boolean {
  return Object.values(filters).some(value => value !== undefined && value !== '');
}

export function PrintJobsTable() {
  const { t } = useTranslation('wAdmin');
  const [staged, setStaged] = useState<PrintJobFilters>({});
  const [appliedFilters, setAppliedFilters] = useState<PrintJobFilters>({});
  const [selectedRow, setSelectedRow] = useState<PrintJob | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, status } =
    usePrintJobs(appliedFilters);

  const rows = useMemo(() => (data?.pages ?? []).flat(), [data]);

  const { data: selectedDetail } = usePrintJob(selectedRow?.jobId ?? '');

  function openSheet(row: PrintJob) {
    setSelectedRow(row);
    setSheetOpen(true);
  }

  // Print job jobs are not an EntityIdCell "linkable" entityType (payment/
  // tab/staff only), so this renders as plain truncated mono text + a copy
  // button — no navigation link, which is correct here (no /print-jobs route).
  const columns: ColumnDef<PrintJob>[] = [
    {
      id: 'jobId',
      accessorKey: 'jobId',
      header: t('printJobsTable.columnJobId'),
      cell: ({ row }) => {
        const job = row.original;
        return (
          <>
            {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- propagation-stopper only, not an interactive element itself */}
            <div
              onClick={e => {
                e.stopPropagation();
              }}
            >
              {/* eslint-disable-next-line i18next/no-literal-string -- entityType is a protocol/domain identifier, not UI copy (matches AuditLogTable's own entityType column) */}
              <EntityIdCell entityType="print_job" entityId={job.jobId} />
            </div>
            <Button
              type="button"
              variant="link"
              className="sr-only"
              aria-label={t('printJobsTable.viewJobAriaLabel', {
                jobId: job.jobId,
                createdAt: formatDate(job.createdAt),
              })}
              onClick={() => {
                openSheet(job);
              }}
            >
              {t('printJobsTable.viewJob')}
            </Button>
          </>
        );
      },
    },
    {
      id: 'origin',
      accessorKey: 'origin',
      header: t('printJobsTable.columnOrigin'),
    },
    {
      id: 'printerName',
      accessorKey: 'printerName',
      header: t('printJobsTable.columnPrinter'),
      cell: ({ row }) => <span className="truncate">{row.original.printerName}</span>,
    },
    {
      id: 'status',
      header: t('printJobsTable.columnStatus'),
      cell: ({ row }) => (
        <PrintJobStatusBadge
          status={row.original.status}
          onReprint={() => {
            // Reprinting from a list-view badge is out of this plan's scope
            // (D-05/D-06 wiring lives on the print-triggering callers, e.g.
            // ReprintButton) — a no-op here keeps the badge purely informational.
          }}
        />
      ),
    },
    {
      id: 'attempts',
      accessorKey: 'attempts',
      header: t('printJobsTable.columnAttempts'),
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: t('printJobsTable.columnCreatedAt'),
      cell: ({ row }) => formatDate(row.original.createdAt),
    },
  ];

  const filtersApplied = hasAnyFilter(appliedFilters);

  let emptyState: React.ReactNode | undefined;
  if (status === 'error') {
    emptyState = (
      <EmptyState
        icon={Printer}
        title={t('printJobsTable.loadErrorTitle')}
        description={t('printJobsTable.loadErrorDescription')}
      />
    );
  } else if (status === 'success' && rows.length === 0) {
    emptyState = filtersApplied ? (
      <EmptyState
        icon={Printer}
        title={t('printJobsTable.noMatchesTitle')}
        description={t('printJobsTable.noMatchesBody')}
      />
    ) : (
      <EmptyState
        icon={Printer}
        title={t('printJobsTable.emptyTitle')}
        description={t('printJobsTable.emptyBody')}
      />
    );
  }

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={rows}
        isLoading={status === 'pending'}
        toolbar={
          <PrintJobFilterBar staged={staged} onStagedChange={setStaged} onApply={setAppliedFilters} />
        }
        onRowClick={openSheet}
        {...(emptyState ? { emptyState } : {})}
      />

      {hasNextPage && (
        <POSButton
          variant="outline"
          touchSize="default"
          disabled={isFetchingNextPage}
          onClick={() => {
            void fetchNextPage();
          }}
        >
          {isFetchingNextPage && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
          {t('printJobsTable.loadMoreEntries')}
        </POSButton>
      )}

      <PrintJobDetailSheet
        row={selectedRow && selectedDetail ? selectedDetail : null}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
