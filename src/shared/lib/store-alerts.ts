import { z } from 'zod';
import catalogJson from './store-alert-catalog.json';
import { pickBackupAlert, type BackupAlertPick, type StoreStatus } from './store-status';

export const ConsoleActionSchema = z.enum([
  'SetUpServer',
  'ResumeSetup',
  'AddTill',
  'JoinServer',
  'ShowRecoveryKey',
]);
export type ConsoleAction = z.infer<typeof ConsoleActionSchema>;

const CatalogSchema = z.record(
  z.string(),
  z.object({ severity: z.enum(['warn', 'critical']), action: ConsoleActionSchema.nullable() })
);
export const STORE_ALERT_CATALOG = CatalogSchema.parse(catalogJson);

export type StoreAlertInfo = { known: boolean; action: ConsoleAction | null };

/** An unknown code (a later plan added it) is shown with generic text and no button. */
export function alertInfo(code: string): StoreAlertInfo {
  const entry = STORE_ALERT_CATALOG[code];
  return entry ? { known: true, action: entry.action } : { known: false, action: null };
}

const isCritical = (level: string): boolean => level.toLowerCase() === 'critical';

/**
 * What the shell bar shows: the backup pick (unchanged), plus any critical non-backup alert. A critical alert
 * outranks a backup warning; a critical backup alert keeps its place. Non-backup warnings live on the page only.
 */
export function pickStoreAlert(status: StoreStatus): BackupAlertPick | null {
  const backup = pickBackupAlert(status);
  const other = status.alerts.find(a => !a.code.startsWith('BACKUP_') && isCritical(a.level));
  if (backup && (backup.level === 'critical' || !other)) return backup;
  return other ? { code: other.code, level: 'critical', names: [] } : backup;
}

/** Age of the status file in ms. The till's clock can be off, so the server's `Date` header is the reference when present. */
export function statusAgeMs(status: StoreStatus, nowMs: number = Date.now()): number | null {
  const generated = status.generatedAt ? Date.parse(status.generatedAt) : NaN;
  if (Number.isNaN(generated)) return null;
  const header = status.serverDate ? Date.parse(status.serverDate) : NaN;
  return (Number.isNaN(header) ? nowMs : header) - generated;
}
