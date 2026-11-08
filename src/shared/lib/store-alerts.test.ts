import { describe, expect, it } from 'vitest';
import { alertInfo, pickStoreAlert, STORE_ALERT_CATALOG, statusAgeMs } from './store-alerts';
import { StoreStatusSchema, type StoreStatus } from './store-status';

const st = (o: object): StoreStatus =>
  StoreStatusSchema.parse({ schema: 1, generatedAt: '2026-11-04T10:00:00Z', ...o });

describe('store alert catalog', () => {
  it('maps known codes to an action and treats unknown codes as generic', () => {
    expect(alertInfo('BACKUP_KEY_NOT_EXPORTED')).toEqual({
      known: true,
      action: 'ShowRecoveryKey',
    });
    expect(alertInfo('SOMETHING_NEW')).toEqual({ known: false, action: null });
    expect(Object.keys(STORE_ALERT_CATALOG).length).toBeGreaterThanOrEqual(30);
  });
});

describe('pickStoreAlert', () => {
  it('keeps the backup behaviour', () => {
    const s = st({ alerts: [{ code: 'BACKUP_STALE_24H', level: 'warn', since: 'x' }] });
    expect(pickStoreAlert(s)?.code).toBe('BACKUP_STALE_24H');
  });
  it('shows a critical non-backup alert and ignores a non-backup warning', () => {
    expect(
      pickStoreAlert(st({ alerts: [{ code: 'DISK_LOW', level: 'critical', since: null }] }))
    ).toMatchObject({ code: 'DISK_LOW', level: 'critical' });
    expect(
      pickStoreAlert(st({ alerts: [{ code: 'DISK_LOW', level: 'warn', since: null }] }))
    ).toBeNull();
  });
  it('lets a critical alert outrank a backup warning but not a critical backup alert', () => {
    const warn = { code: 'BACKUP_STALE_24H', level: 'warn', since: 'x' };
    const crit = { code: 'SCHEMA_MISMATCH', level: 'critical', since: 'x' };
    expect(pickStoreAlert(st({ alerts: [warn, crit] }))?.code).toBe('SCHEMA_MISMATCH');
    expect(
      pickStoreAlert(
        st({ alerts: [{ code: 'BACKUP_VERIFY_FAILED', level: 'critical', since: 'x' }, crit] })
      )?.code
    ).toBe('BACKUP_VERIFY_FAILED');
  });
});

describe('status parsing and age', () => {
  it('parses null nested fields', () => {
    const s = st({
      services: null,
      database: { maxVersion: null, applied: null, expected: null },
      network: { profile: null },
      packVersion: null,
    });
    expect(s.services).toBeNull();
  });
  it('parses a full server body', () => {
    const s = st({
      state: 'running',
      packVersion: '1.2',
      services: { pg: { state: 'running', healthy: true } },
      database: { maxVersion: '2026', applied: 3, expected: { maxVersion: '2026', applied: 3 } },
      network: { profile: 'Private' },
    });
    expect(s.services?.['pg']?.healthy).toBe(true);
  });
  it('measures age against the server Date header so a till clock 10 minutes off does not matter', () => {
    const s = { ...st({}), serverDate: 'Wed, 04 Nov 2026 10:02:00 GMT' };
    const tillNow = Date.parse('2026-11-04T10:12:00Z');
    expect(statusAgeMs(s, tillNow)).toBe(120_000);
    expect(statusAgeMs(st({}), tillNow)).toBe(12 * 60_000);
    expect(statusAgeMs(StoreStatusSchema.parse({ schema: 1 }), tillNow)).toBeNull();
  });
});
