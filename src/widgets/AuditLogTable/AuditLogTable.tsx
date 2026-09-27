/**
 * AuditLogTable — composite widget for the `/audit` page.
 *
 * Composes AuditLogFilterBar (5 staged filters + Apply) + DataTable
 * (infinite-scroll, page size 50, "Load more entries") + AuditLogDetailSheet
 * (click-to-open right-side diff Sheet). Satisfies the DOM/a11y contract
 * locked by e2e/38-audit-logs.spec.ts (14-UI-SPEC.md section C):
 *   - a <TableCell> containing the raw action string as plain text
 *   - an accessible sr-only trigger per row (rendered via the shared Button primitive),
 *     name = "View diff for {action} on {date}"
 */
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardList, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuditLogs } from '@entities/audit-log';
import type { AuditLog, AuditLogFilters } from '@entities/audit-log';
import { useStaffList } from '@entities/staff';
import { DataTable } from '@shared/ui/DataTable';
import { EmptyState } from '@shared/ui/EmptyState';
import { EntityIdCell } from '@shared/ui/EntityIdCell';
import { POSButton } from '@shared/ui/POSButton';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';

import { AuditLogDetailSheet } from './AuditLogDetailSheet';
import { AuditLogFilterBar } from './AuditLogFilterBar';

function formatAuditDate(date: Date): string {
  return date.toLocaleString();
}

function hasAnyFilter(filters: AuditLogFilters): boolean {
  return Object.values(filters).some(value => value !== undefined && value !== '');
}

export function AuditLogTable() {
  const { t } = useTranslation('wAdmin');
  const [staged, setStaged] = useState<AuditLogFilters>({});
  const [appliedFilters, setAppliedFilters] = useState<AuditLogFilters>({});
  const [selectedRow, setSelectedRow] = useState<AuditLog | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const { data: staffList } = useStaffList();
  const staffNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const staff of staffList ?? []) {
      map.set(staff.id, staff.name);
    }
    return map;
  }, [staffList]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, status } =
    useAuditLogs(appliedFilters);

  const rows = useMemo(() => (data?.pages ?? []).flat(), [data]);

  function openSheet(row: AuditLog) {
    setSelectedRow(row);
    setSheetOpen(true);
  }

  const columns: ColumnDef<AuditLog>[] = [
    {
      id: 'action',
      accessorKey: 'action',
      header: t('auditLogTable.columnAction'),
      cell: ({ row }) => {
        const auditLog = row.original;
        return (
          <>
            {auditLog.action}
            <Button
              type="button"
              variant="link"
              className="sr-only"
              aria-label={t('auditLogTable.viewDiffAriaLabel', {
                action: auditLog.action,
                date: formatAuditDate(auditLog.createdAt),
              })}
              onClick={() => {
                openSheet(auditLog);
              }}
            >
              {t('auditLogTable.viewDiff')}
            </Button>
          </>
        );
      },
    },
    {
      id: 'entityType',
      accessorKey: 'entityType',
      header: t('auditLogTable.columnEntityType'),
    },
    {
      id: 'entityId',
      header: t('auditLogTable.columnEntityId'),
      cell: ({ row }) => (
        // Row has onRowClick (opens the diff sheet) — stop the link/copy
        // button clicks from also bubbling into that handler.
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- propagation-stopper only, not an interactive element itself
        <div
          onClick={e => {
            e.stopPropagation();
          }}
        >
          <EntityIdCell
            entityType={row.original.entityType}
            entityId={row.original.entityId ?? undefined}
          />
        </div>
      ),
    },
    {
      id: 'actor',
      header: t('auditLogTable.columnActor'),
      cell: ({ row }) => {
        const actorId = row.original.actorId;
        return actorId ? (staffNameMap.get(actorId) ?? actorId) : t('auditLogTable.system');
      },
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: t('auditLogTable.columnTimestamp'),
      cell: ({ row }) => formatAuditDate(row.original.createdAt),
    },
    {
      id: 'source',
      accessorKey: 'source',
      header: t('auditLogTable.columnSource'),
      cell: ({ row }) => <Badge variant="outline">{row.original.source}</Badge>,
    },
  ];

  const filtersApplied = hasAnyFilter(appliedFilters);

  let emptyState: React.ReactNode | undefined;
  if (status === 'error') {
    emptyState = (
      <EmptyState
        icon={ClipboardList}
        title={t('auditLogTable.loadErrorTitle')}
        description={t('auditLogTable.loadErrorDescription')}
      />
    );
  } else if (status === 'success' && rows.length === 0) {
    emptyState = filtersApplied ? (
      <EmptyState
        icon={ClipboardList}
        title={t('auditLogTable.noMatchesTitle')}
        description={t('auditLogTable.noMatchesDescription')}
      />
    ) : (
      <EmptyState
        icon={ClipboardList}
        title={t('auditLogTable.noActivityTitle')}
        description={t('auditLogTable.noActivityDescription')}
      />
    );
  }

  const selectedActorName =
    selectedRow?.actorId && staffNameMap.has(selectedRow.actorId)
      ? (staffNameMap.get(selectedRow.actorId) ?? null)
      : null;

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={rows}
        isLoading={status === 'pending'}
        toolbar={
          <AuditLogFilterBar staged={staged} onStagedChange={setStaged} onApply={setAppliedFilters} />
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
          {t('auditLogTable.loadMoreEntries')}
        </POSButton>
      )}

      <AuditLogDetailSheet
        row={selectedRow}
        actorName={selectedActorName}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
