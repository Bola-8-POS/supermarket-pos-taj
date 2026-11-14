import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EditRoleDialog } from '@features/edit-staff-role';
import { useStaffList } from '@entities/staff';
import { useStaffStore } from '@entities/staff/model/store';
import type { Staff } from '@shared/lib/domain';
import { DataTable } from '@shared/ui/DataTable';
import { POSButton } from '@shared/ui/POSButton';
import { Badge } from '@shared/ui/badge';

import { PermissionMatrix } from './PermissionMatrix';

export function RBACDashboard() {
  const { t } = useTranslation('wAdmin');
  const { data: staffList, isIdleOrLoading } = useStaffList();
  const currentStaffId = useStaffStore(s => s.currentStaff?.id) ?? null;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedStaffId, setSelectedStaffId] = useState<string | undefined>(undefined);

  const staff = useMemo(() => staffList ?? [], [staffList]);

  const columns = useMemo<ColumnDef<Staff>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t('rbacDashboard.columnName'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        id: 'role',
        header: t('rbacDashboard.columnRole'),
        cell: ({ row }) => (
          <Badge variant="outline" className="capitalize">
            {row.original.role}
          </Badge>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const member = row.original;
          const isSelf = member.id === currentStaffId;
          return (
            <div className="flex justify-end gap-2">
              <POSButton
                type="button"
                size="sm"
                variant="outline"
                disabled={isSelf}
                onClick={() => {
                  setSelectedStaffId(member.id);
                  setDialogOpen(true);
                }}
              >
                {t('rbacDashboard.editRole')}
              </POSButton>
            </div>
          );
        },
      },
    ],
    [currentStaffId, t]
  );

  return (
    <div className="space-y-8">
      {/* Panel 1: Staff Roles (Phase 12 — unchanged) */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('rbacDashboard.staffRolesTitle')}</h2>
        <div className="flex flex-wrap gap-2">
          <POSButton
            type="button"
            variant="secondary"
            touchSize="default"
            onClick={() => {
              toast.message(t('rbacDashboard.addStaffToastTitle'), {
                description: t('rbacDashboard.addStaffToastDescription'),
              });
            }}
          >
            {t('rbacDashboard.addStaff')}
          </POSButton>
          <POSButton
            type="button"
            variant="secondary"
            touchSize="default"
            onClick={() => {
              toast.message(t('rbacDashboard.deactivateToastTitle'), {
                description: t('rbacDashboard.deactivateToastDescription'),
              });
            }}
          >
            {t('rbacDashboard.deactivate')}
          </POSButton>
        </div>

        <DataTable
          columns={columns}
          data={staff}
          isLoading={isIdleOrLoading}
          searchable
          searchPlaceholder={t('rbacDashboard.searchStaffPlaceholder')}
        />

        <EditRoleDialog
          key={selectedStaffId ?? 'no-selection'}
          open={dialogOpen}
          onOpenChange={open => {
            setDialogOpen(open);
            if (!open) setSelectedStaffId(undefined);
          }}
          staff={staff}
          currentStaffId={currentStaffId}
          preSelectedStaffId={selectedStaffId}
        />
      </div>

      {/* Panel 2: Permission Matrix (Phase 13) */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{t('rbacDashboard.permissionMatrixTitle')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('rbacDashboard.permissionMatrixDescription')}
          </p>
        </div>
        <PermissionMatrix />
      </div>
    </div>
  );
}
