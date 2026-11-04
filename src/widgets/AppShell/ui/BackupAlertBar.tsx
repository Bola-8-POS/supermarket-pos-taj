import { useTranslation } from 'react-i18next';
import { useStaffStore } from '@entities/staff/model/store';
import { useStoreStatus } from '@entities/store-status';
import { getCurrentLocale } from '@shared/lib/i18n';
import { isListedBackupCode, pickBackupAlert } from '@shared/lib/store-status';
import { cn } from '@shared/lib/utils';

/**
 * In-flow bar for the owner (admin role) while the store's backups are stale, a backup drive is missing,
 * the recovery key was never saved, or the weekly restore check failed. Not dismissible. Renders nothing
 * for other roles, hosted stores and when the server does not answer.
 */
export function BackupAlertBar() {
  const { t } = useTranslation('common');
  const isAdmin = useStaffStore(s => s.currentStaff?.role === 'admin');
  const { data } = useStoreStatus({ enabled: isAdmin });
  if (!isAdmin || !data?.ok) return null;
  const pick = pickBackupAlert(data.data);
  if (!pick) return null;
  const critical = pick.level === 'critical';
  const names = new Intl.ListFormat(getCurrentLocale(), { type: 'conjunction' }).format(pick.names);
  // listed codes keep their own text; any other BACKUP_* code gets the generic one
  const message =
    pick.code === 'BACKUP_DEST_DOWN'
      ? pick.names.length === 0
        ? t('storeBackup.banner.BACKUP_DEST_DOWN_unnamed')
        : t('storeBackup.banner.BACKUP_DEST_DOWN', { count: pick.names.length, names })
      : (pick.code === 'BACKUP_STALE_24H' || pick.code === 'BACKUP_STALE_72H') && pick.reason === 'no-destination'
        ? t(`storeBackup.banner.${pick.code}_noDest`)
        : isListedBackupCode(pick.code)
        ? t(`storeBackup.banner.${pick.code}`)
        : t('storeBackup.banner.BACKUP_OTHER');
  return (
    <div
      role={critical ? 'alert' : 'status'}
      data-testid="backup-alert-bar"
      data-code={pick.code}
      data-level={pick.level}
      className={cn(
        'flex min-h-8 shrink-0 items-center justify-center px-3 py-1 text-center text-xs font-semibold',
        critical ? 'bg-destructive text-destructive-foreground' : 'bg-warning text-warning-foreground'
      )}
    >
      {message}
    </div>
  );
}
