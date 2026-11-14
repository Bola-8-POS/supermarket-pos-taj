import { describe, expect, it } from 'vitest';
import en from '@shared/lib/i18n/locales/en-US/common.json';
import es from '@shared/lib/i18n/locales/es-MX/common.json';
import { BACKUP_ALERT_CODES } from '@shared/lib/store-status';

type Banner = Record<string, string>;
const banner = (c: unknown): Banner => (c as { storeBackup: { banner: Banner } }).storeBackup.banner;
const placeholders = (s: string): string[] => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1] ?? '').sort();
/** i18next resolves a plural key through its _one/_other suffixes. */
const hasMessage = (b: Banner, key: string): boolean => Boolean(b[key]) || (Boolean(b[`${key}_one`]) && Boolean(b[`${key}_other`]));
const guard = (): void => {
  expect(en, 'en storeBackup.banner').toHaveProperty('storeBackup.banner');
  expect(es, 'es storeBackup.banner').toHaveProperty('storeBackup.banner');
};

describe('storeBackup catalogs', () => {
  it('has one non-empty message per alert code, plus the generic and unnamed variants, in both languages', () => {
    guard();
    for (const code of [...BACKUP_ALERT_CODES, 'BACKUP_OTHER', 'BACKUP_DEST_DOWN_unnamed', 'BACKUP_STALE_24H_noDest', 'BACKUP_STALE_72H_noDest']) {
      expect(hasMessage(banner(en), code), `en ${code}`).toBe(true);
      expect(hasMessage(banner(es), code), `es ${code}`).toBe(true);
    }
    expect(Object.keys(banner(en)).sort()).toEqual(Object.keys(banner(es)).sort());
  });

  it('uses the same {{placeholders}} in both languages for every key', () => {
    guard();
    for (const [key, text] of Object.entries(banner(en))) {
      expect(placeholders(banner(es)[key] ?? ''), key).toEqual(placeholders(text));
    }
  });

  it('puts the drive names into the named missing-drive messages in both languages, and not into the unnamed one', () => {
    guard();
    for (const b of [banner(en), banner(es)]) {
      expect(b['BACKUP_DEST_DOWN_one']).toContain('{{names}}');
      expect(b['BACKUP_DEST_DOWN_other']).toContain('{{names}}');
      expect(b['BACKUP_DEST_DOWN_unnamed']).not.toContain('{{names}}');
    }
  });
});
