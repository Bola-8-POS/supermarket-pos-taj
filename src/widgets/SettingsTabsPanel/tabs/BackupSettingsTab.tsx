import { Database } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useMutationCreateSettingsBackup,
  useMutationRestoreSettingsBackup,
  useSettingsBackups,
} from '@entities/settings';
import type { SettingsBackupSummary, UserRole } from '@shared/lib/domain';
import { ConfirmDialog, EmptyState, LockedFeature, POSButton, ProtectedAction } from '@shared/ui';

type Props = {
  currentRole: UserRole | null;
};

export function BackupSettingsTab({ currentRole }: Props) {
  const { t } = useTranslation('wAdmin');
  const backupsQuery = useSettingsBackups();
  const createBackup = useMutationCreateSettingsBackup();
  const restoreBackup = useMutationRestoreSettingsBackup();
  const [restoreTarget, setRestoreTarget] = useState<SettingsBackupSummary | null>(null);

  const defaultLabel = useMemo(
    () =>
      t('backupSettingsTab.defaultLabel', {
        // eslint-disable-next-line i18next/no-literal-string -- date-formatting call, not UI copy
        timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      }),
    [t]
  );

  const handleCreateBackup = async () => {
    const result = await createBackup.mutateAsync(defaultLabel);
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success(t('backupSettingsTab.backupCreated'));
  };

  const handleRestoreBackup = async () => {
    if (!restoreTarget) return;
    const result = await restoreBackup.mutateAsync({ backupId: restoreTarget.id });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    setRestoreTarget(null);
    toast.success(t('backupSettingsTab.backupRestored'));
  };

  return (
    <ProtectedAction
      action="manage_settings"
      currentRole={currentRole}
      disabled={restoreBackup.isPending}
    >
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('backupSettingsTab.title')}</h2>
        <LockedFeature feature="settings_backup">
          <POSButton
            type="button"
            touchSize="large"
            disabled={createBackup.isPending || restoreBackup.isPending}
            onClick={() => {
              void handleCreateBackup();
            }}
          >
            {createBackup.isPending
              ? t('backupSettingsTab.creatingBackup')
              : t('backupSettingsTab.createManualBackup')}
          </POSButton>
        </LockedFeature>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t('backupSettingsTab.backupHistory')}</h3>
          {backupsQuery.data == null || backupsQuery.data.length === 0 ? (
            <EmptyState
              icon={Database}
              title={t('backupSettingsTab.emptyTitle')}
              description={t('backupSettingsTab.emptyDescription')}
            />
          ) : (
            <div className="space-y-2">
              {backupsQuery.data.map(backup => (
                <div
                  key={backup.id}
                  className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium">{backup.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('backupSettingsTab.createdAt', {
                        date: backup.createdAt.toLocaleString(),
                      })}
                      {backup.restoredAt
                        ? t('backupSettingsTab.restoredAtSuffix', {
                            date: backup.restoredAt.toLocaleString(),
                          })
                        : ''}
                    </p>
                  </div>
                  <LockedFeature feature="settings_backup">
                    <POSButton
                      type="button"
                      touchSize="default"
                      variant="outline"
                      disabled={restoreBackup.isPending}
                      onClick={() => {
                        setRestoreTarget(backup);
                      }}
                    >
                      {t('backupSettingsTab.restore')}
                    </POSButton>
                  </LockedFeature>
                </div>
              ))}
            </div>
          )}
        </div>

        <ConfirmDialog
          open={restoreTarget != null}
          title={t('backupSettingsTab.restoreConfirmTitle')}
          description={t('backupSettingsTab.restoreConfirmDescription')}
          confirmLabel={
            restoreBackup.isPending
              ? t('backupSettingsTab.restoring')
              : t('backupSettingsTab.restoreBackupLabel')
          }
          isLoading={restoreBackup.isPending}
          onCancel={() => {
            setRestoreTarget(null);
          }}
          onConfirm={() => {
            void handleRestoreBackup();
          }}
        />
      </div>
    </ProtectedAction>
  );
}
