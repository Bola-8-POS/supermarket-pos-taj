import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalTimeZone } from './timezone';

describe('canonicalTimeZone', () => {
  it('a timezone is saved in its canonical spelling', () => {
    expect(canonicalTimeZone('america/mexico_city')).toBe('America/Mexico_City');
    expect(canonicalTimeZone('  ASIA/TOKYO ')).toBe('Asia/Tokyo');
    expect(canonicalTimeZone('utc')).toBe('UTC');
  });

  it('UTC-6 is not accepted as a store timezone', () => {
    for (const bad of ['UTC-6', 'UTC+6', 'EST', 'GMT-6', '+05:00', '']) {
      expect(canonicalTimeZone(bad), bad).toBeNull();
    }
  });

  it('Asia/Kolkata is accepted and saved in its canonical spelling', () => {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata' }).resolvedOptions()
      .timeZone;
    expect(canonicalTimeZone(' asia/kolkata ')).toBe(resolved);
  });

  it('Etc/UTC is accepted', () => {
    expect(canonicalTimeZone('Etc/UTC')).not.toBeNull();
  });

  it('an offset or abbreviation is still refused', () => {
    for (const bad of ['UTC-6', 'GMT-6', '-06:00', 'EST', 'PST', 'Not/AZone']) {
      expect(canonicalTimeZone(bad), bad).toBeNull();
    }
  });

  describe('without Intl.supportedValuesOf', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('a missing supportedValuesOf does not throw', async () => {
      vi.resetModules();
      const original = Intl.supportedValuesOf;
      // @ts-expect-error simulating an older runtime
      Intl.supportedValuesOf = undefined;
      try {
        const mod = await import('./timezone');
        expect(mod.canonicalTimeZone('UTC')).toBe('UTC');
        expect(mod.canonicalTimeZone('Asia/Kolkata')).not.toBeNull();
        expect(() => mod.supportedTimeZones()).not.toThrow();
      } finally {
        Intl.supportedValuesOf = original;
      }
    });
  });
});
