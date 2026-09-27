/**
 * EditHistoryTable — read-only widget for the `/edit-history` page (D-04, SC-4).
 *
 * Filtered clone of AuditLogTable.tsx: hardcodes `useAuditLogs({ action: 'tab.edit_paid' })`
 * (no user-facing filter bar) and adds Reason + Ticket columns on top of the base
 * action/entityType/actor/createdAt/source columns. Reuses AuditLogDetailSheet/
 * JsonDiffViewer unmodified — same DOM/a11y contract as AuditLogTable (sr-only
 * "View diff" trigger per row, satisfies e2e/38-audit-logs.spec.ts's shape).
 */
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardList, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AuditLogDetailSheet } from '@widgets/AuditLogTable/AuditLogDetailSheet';

import { useAuditLogs } from '@entities/audit-log';
import type { AuditLog } from '@entities/audit-log';
import { useStaffList } from '@entities/staff';
import { DataTable } from '@shared/ui/DataTable';
import { EmptyState } from '@shared/ui/EmptyState';
import { EntityIdCell } from '@shared/ui/EntityIdCell';
import { POSButton } from '@shared/ui/POSButton';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';

function formatAuditDate(date: Date): string {
  return date.toLocaleString();
}

export function EditHistoryTable() {
  const { t } = useTranslation('wAdmin');
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

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, status } = useAuditLogs({
    // eslint-disable-next-line i18next/no-literal-string -- AuditAction enum identifier, not UI copy
    action: 'tab.edit_paid',
  });

  const rows = useMemo(() => (data?.pages ?? []).flat(), [data]);

  function openSheet(row: AuditLog) {
    setSelectedRow(row);
    setSheetOpen(true);
  }

  const columns: ColumnDef<AuditLog>[] = [
    {
      id: 'action',
      accessorKey: 'action',
      header: t('editHistoryTable.columnAction'),
      cell: ({ row }) => {
        const auditLog = row.original;
        return (
          <>
            {auditLog.action}
            <Button
              type="button"
              variant="link"
              className="sr-only"
              aria-label={t('editHistoryTable.viewDiffAriaLabel', {
                action: auditLog.action,
                date: formatAuditDate(auditLog.createdAt),
              })}
              onClick={() => {
                openSheet(auditLog);
              }}
            >
              {t('editHistoryTable.viewDiff')}
            </Button>
          </>
        );
      },
    },
    {
      id: 'entityType',
      accessorKey: 'entityType',
      header: t('editHistoryTable.columnEntityType'),
    },
    {
      id: 'reason',
      header: t('editHistoryTable.columnReason'),
      cell: ({ row }) => {
        const after = row.original.after as Record<string, unknown> | null;
        return typeof after?.['reason'] === 'string' ? after['reason'] : '—';
      },
    },
    {
      id: 'ticket',
      header: t('editHistoryTable.columnTicket'),
      cell: ({ row }) => (
        // Row has onRowClick (opens the diff sheet) — stop the link/copy
        // button clicks from also bubbling into that handler.
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- propagation-stopper only, not an interactive element itself
        <div
          onClick={e => {
            e.stopPropagation();
          }}
        >
          {/* eslint-disable-next-line i18next/no-literal-string -- EntityType domain identifier, not UI copy (EditHistoryTable is always tab.edit_paid-scoped) */}
          <EntityIdCell entityType="tab" entityId={row.original.entityId ?? undefined} />
        </div>
      ),
    },
    {
      id: 'actor',
      header: t('editHistoryTable.columnActor'),
      cell: ({ row }) => {
        const actorId = row.original.actorId;
        return actorId ? (staffNameMap.get(actorId) ?? actorId) : t('editHistoryTable.system');
      },
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: t('editHistoryTable.columnTimestamp'),
      cell: ({ row }) => formatAuditDate(row.original.createdAt),
    },
    {
      id: 'source',
      accessorKey: 'source',
      header: t('editHistoryTable.columnSource'),
      cell: ({ row }) => <Badge variant="outline">{row.original.source}</Badge>,
    },
  ];

  let emptyState: React.ReactNode | undefined;
  if (status === 'error') {
    emptyState = (
      <EmptyState
        icon={ClipboardList}
        title={t('editHistoryTable.loadErrorTitle')}
        description={t('editHistoryTable.loadErrorDescription')}
      />
    );
  } else if (status === 'success' && rows.length === 0) {
    emptyState = (
      <EmptyState
        icon={ClipboardList}
        title={t('editHistoryTable.noActivityTitle')}
        description={t('editHistoryTable.noActivityDescription')}
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
          {t('editHistoryTable.loadMoreEntries')}
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
