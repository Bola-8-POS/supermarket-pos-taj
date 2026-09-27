import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useMutationTogglePermission } from '@features/toggle-permission';
import { useRolePermissions } from '@entities/rbac';
import { useStaffStore } from '@entities/staff/model/store';
import { logger } from '@shared/lib/logger-instance';
import { STAFF_ACTIONS, STAFF_ROLES } from '@shared/lib/rbac';
import type { StaffAction, StaffRole } from '@shared/lib/rbac';
import { LockedFeature, Switch } from '@shared/ui';

const ROLE_LABELS: Record<StaffRole, string> = {
  cashier: 'Cashier',
  manager: 'Manager',
  admin: 'Admin',
  kitchen: 'Kitchen',
};

export function PermissionMatrix() {
  const { t } = useTranslation('wAdmin');
  const currentRole = useStaffStore(s => s.currentStaff?.role);
  const isAdmin = currentRole === 'admin';

  const { data: permResult, isLoading } = useRolePermissions();
  const permMap =
    permResult && permResult.ok ? permResult.data : new Map<StaffRole, Set<StaffAction>>();

  const mutation = useMutationTogglePermission();

  const handleToggle = async (
    role: StaffRole,
    action: StaffAction,
    checked: boolean
  ): Promise<void> => {
    const result = await mutation.mutateAsync({ role, action, enabled: checked });
    if (!result.ok) {
      logger.error('permission-matrix.toggle.failed', {
        role,
        action,
        message: result.error.message,
      });
      toast.error(t('permissionMatrix.updateFailed'), { description: result.error.message });
      return;
    }
    toast.success(
      checked ? t('permissionMatrix.permissionEnabled') : t('permissionMatrix.permissionDisabled'),
      {
        description: `${ROLE_LABELS[role]} / ${action}`,
      }
    );
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">{t('permissionMatrix.loading')}</div>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-xs">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="min-w-[180px] bg-muted/60 px-4 py-2.5 text-left text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              {t('permissionMatrix.columnAction')}
            </th>
            {STAFF_ROLES.map(role => (
              <th
                key={role}
                className="min-w-[90px] bg-muted/60 px-3 py-2.5 text-center text-[0.6875rem] font-semibold tracking-[0.08em] uppercase"
              >
                {ROLE_LABELS[role]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {STAFF_ACTIONS.map(action => (
            <tr key={action} className="border-t border-border transition-colors hover:bg-muted/40">
              <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{action}</td>
              {STAFF_ROLES.map(role => {
                const checked = permMap.get(role)?.has(action) ?? false;
                return (
                  <td key={role} className="px-3 py-2 text-center">
                    <LockedFeature feature="rbac_editing">
                      <Switch
                        checked={checked}
                        disabled={!isAdmin || mutation.isPending}
                        onCheckedChange={newChecked => {
                          void handleToggle(role, action, newChecked);
                        }}
                        aria-label={`${ROLE_LABELS[role]} can ${action}`}
                      />
                    </LockedFeature>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
