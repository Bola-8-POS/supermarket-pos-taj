import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@shared/lib/i18n';
import { ok, err } from '@shared/lib/result';
import type { StoreStatus } from '@shared/lib/store-status';
import { BackupAlertBar } from './BackupAlertBar';

let role: string | undefined = 'admin';
let result: ReturnType<typeof ok<StoreStatus>> | ReturnType<typeof err> | undefined;
const enabledSeen: boolean[] = [];

vi.mock('@entities/staff/model/store', () => ({
  useStaffStore: (sel: (s: { currentStaff: { role: string } | null }) => unknown) =>
    sel({ currentStaff: role ? { role } : null }),
}));
vi.mock('@entities/store-status', () => ({
  useStoreStatus: (o: { enabled: boolean }) => {
    enabledSeen.push(o.enabled);
    return { data: result };
  },
}));

const status = (
  alerts: { code: string; level: string }[],
  destinations: { name: string; ok: boolean }[] = []
): StoreStatus => ({
  schema: 1,
  generatedAt: 'x',
  alerts: alerts.map(a => ({ ...a, since: 'x' })),
  backup: { alert: 'warn', destinations },
});

afterEach(async () => {
  await i18n.changeLanguage('en-US');
});

beforeEach(() => {
  role = 'admin';
  result = undefined;
  enabledSeen.length = 0;
});

describe('BackupAlertBar', () => {
  it('shows a critical, assertive bar for an admin when backups are 3 days behind', () => {
    result = ok(status([{ code: 'BACKUP_STALE_72H', level: 'critical' }]));
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveAttribute('role', 'alert');
    expect(bar).toHaveAttribute('data-code', 'BACKUP_STALE_72H');
    expect(bar).toHaveAttribute('data-level', 'critical');
    expect(bar).toHaveTextContent(/3 days/i);
  });

  it('shows a polite warning that names the missing drive', () => {
    result = ok(
      status([{ code: 'BACKUP_DEST_DOWN', level: 'warn' }], [{ name: 'usb-e', ok: false }])
    );
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveAttribute('role', 'status');
    expect(bar).toHaveTextContent(/usb-e/);
  });

  it('shows a critical non-backup alert with its own text, and nothing for a non-backup warning', () => {
    result = ok(status([{ code: 'DISK_LOW', level: 'critical' }]));
    const { rerender } = render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveAttribute('data-code', 'DISK_LOW');
    expect(bar).toHaveTextContent(/disk space/i);
    result = ok(status([{ code: 'DISK_LOW', level: 'warn' }]));
    rerender(<BackupAlertBar />);
    expect(screen.queryByTestId('backup-alert-bar')).not.toBeInTheDocument();
  });

  it('uses the generic text for a critical code the catalog has no text for', () => {
    result = ok(status([{ code: 'FROM_A_LATER_PLAN', level: 'critical' }]));
    render(<BackupAlertBar />);
    expect(screen.getByTestId('backup-alert-bar')).toHaveTextContent(/reports a problem/i);
  });

  it('is silent for a cashier and does not even ask the server', () => {
    role = 'cashier';
    result = ok(status([{ code: 'BACKUP_STALE_72H', level: 'critical' }]));
    render(<BackupAlertBar />);
    expect(screen.queryByTestId('backup-alert-bar')).not.toBeInTheDocument();
    expect(enabledSeen.length).toBeGreaterThan(0);
    expect(enabledSeen.every(e => !e)).toBe(true);
  });

  it('is silent with no alert, with no answer, and when the server did not answer sensibly', () => {
    result = ok(status([]));
    const { rerender } = render(<BackupAlertBar />);
    expect(screen.queryByTestId('backup-alert-bar')).not.toBeInTheDocument();
    result = undefined;
    rerender(<BackupAlertBar />);
    expect(screen.queryByTestId('backup-alert-bar')).not.toBeInTheDocument();
    result = err({ code: 'NOT_FOUND', message: 'status 404' });
    rerender(<BackupAlertBar />);
    expect(screen.queryByTestId('backup-alert-bar')).not.toBeInTheDocument();
  });

  it('shows a critical bar with the generic message for an unlisted backup code at critical', () => {
    result = ok(status([{ code: 'BACKUP_STATE_UNKNOWN', level: 'critical' }]));
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveAttribute('data-level', 'critical');
    expect(bar).toHaveAttribute('role', 'alert');
    expect(bar).toHaveTextContent(/backups need attention/i);
  });

  it('shows a warn bar with the generic message for an unlisted backup code at warn', () => {
    result = ok(status([{ code: 'BACKUP_RESTORE_WARNING', level: 'warn' }]));
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveAttribute('data-level', 'warn');
    expect(bar).toHaveAttribute('role', 'status');
    expect(bar).toHaveTextContent(/backups need attention/i);
  });

  it('keeps the specific message for a listed code', () => {
    result = ok(status([{ code: 'BACKUP_VERIFY_FAILED', level: 'critical' }]));
    render(<BackupAlertBar />);
    expect(screen.getByTestId('backup-alert-bar')).toHaveTextContent(
      /last check of the backups failed/i
    );
  });

  it('never renders empty parentheses when no drive name is known', () => {
    result = ok(status([{ code: 'BACKUP_DEST_DOWN', level: 'warn' }]));
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).not.toHaveTextContent('()');
    expect(bar).toHaveTextContent(/a backup drive cannot be found/i);
  });

  it('joins several drive names as a list and uses the plural wording', () => {
    result = ok(
      status(
        [{ code: 'BACKUP_DEST_DOWN', level: 'warn' }],
        [
          { name: 'usb-e', ok: false },
          { name: 'usb-f', ok: false },
        ]
      )
    );
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveTextContent('usb-e and usb-f');
    expect(bar).toHaveTextContent(/backup drives/i);
  });

  it('says "the server PC", not "this PC", in English on every till', () => {
    result = ok(status([{ code: 'BACKUP_STALE_72H', level: 'critical' }]));
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveTextContent('outside the server PC');
    expect(bar).not.toHaveTextContent('this PC');
  });

  it('says "la PC del servidor", not "este equipo", in Spanish on every till', async () => {
    await i18n.changeLanguage('es-MX');
    result = ok(status([{ code: 'BACKUP_STALE_24H', level: 'warn' }]));
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveTextContent('fuera de la PC del servidor');
    expect(bar).not.toHaveTextContent('este equipo');
  });

  it('uses the singular wording for one missing drive in English', () => {
    result = ok(
      status([{ code: 'BACKUP_DEST_DOWN', level: 'warn' }], [{ name: 'usb-e', ok: false }])
    );
    render(<BackupAlertBar />);
    expect(screen.getByTestId('backup-alert-bar')).toHaveTextContent(
      'The backup drive (usb-e) cannot be found.'
    );
  });

  it('shows a critical bar when the level arrives as CRITICAL', () => {
    result = ok(status([{ code: 'BACKUP_STALE_72H', level: 'CRITICAL' }]));
    render(<BackupAlertBar />);
    expect(screen.getByTestId('backup-alert-bar')).toHaveAttribute('data-level', 'critical');
  });

  it('tells the owner to leave the server PC on overnight for the daily check, naming no weekday (English)', () => {
    result = ok(status([{ code: 'BACKUP_VERIFY_OVERDUE', level: 'warn' }]));
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveTextContent('Leave the server PC on overnight so the daily check can run.');
    expect(bar).not.toHaveTextContent(/sunday|monday|tuesday|wednesday|thursday|friday|saturday/i);
  });

  it('tells the owner to leave the server PC on overnight for the daily check, naming no weekday (Spanish)', async () => {
    await i18n.changeLanguage('es-MX');
    result = ok(status([{ code: 'BACKUP_VERIFY_OVERDUE', level: 'warn' }]));
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveTextContent(
      'Deja la PC del servidor encendida durante la noche para que se haga la revisión diaria.'
    );
    expect(bar).not.toHaveTextContent(/domingo|lunes|martes|miércoles|jueves|viernes|sábado/i);
  });

  it('tells a store with no backup drive to set one up, not just to connect it (English)', () => {
    result = ok({
      ...status([{ code: 'BACKUP_STALE_24H', level: 'warn' }]),
      alerts: [{ code: 'BACKUP_STALE_24H', level: 'warn', since: 'x', reason: 'no-destination' }],
    });
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveTextContent('Connect a USB drive and set it up as a backup drive.');
    expect(bar).not.toHaveTextContent('Connect the backup USB drive');
  });

  it('tells a store with no backup drive to set one up, at critical too (Spanish)', async () => {
    await i18n.changeLanguage('es-MX');
    result = ok({
      ...status([{ code: 'BACKUP_STALE_72H', level: 'critical' }]),
      alerts: [
        { code: 'BACKUP_STALE_72H', level: 'critical', since: 'x', reason: 'no-destination' },
      ],
    });
    render(<BackupAlertBar />);
    const bar = screen.getByTestId('backup-alert-bar');
    expect(bar).toHaveTextContent('Conecta una unidad USB y configúrala como unidad de respaldo');
    expect(bar).not.toHaveTextContent('Conecta la unidad USB de respaldo');
  });

  it('keeps the plain wording when the stale alert has another reason', () => {
    result = ok({
      ...status([{ code: 'BACKUP_STALE_24H', level: 'warn' }]),
      alerts: [{ code: 'BACKUP_STALE_24H', level: 'warn', since: 'x', reason: 'copy-failing' }],
    });
    render(<BackupAlertBar />);
    expect(screen.getByTestId('backup-alert-bar')).toHaveTextContent(
      'Connect the backup USB drive.'
    );
  });
});
