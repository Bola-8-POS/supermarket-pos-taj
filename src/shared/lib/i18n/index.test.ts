import { afterEach, describe, expect, it } from 'vitest';
import i18n from './index';

describe('i18n singleton', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en-US'); // reset to the test-suite default (see test-setup.ts)
  });

  it('resolves common:actions.save to Guardar in es-MX', async () => {
    await i18n.changeLanguage('es-MX');
    expect(i18n.language).toBe('es-MX');
    expect(i18n.t('common:actions.save')).toBe('Guardar');
  });

  it('resolves common:actions.save to Save in en-US', () => {
    expect(i18n.t('common:actions.save')).toBe('Save');
  });

  it('has fallbackLng configured to es-MX (D-02)', () => {
    // i18next normalizes a string fallbackLng option to an array internally.
    expect(i18n.options.fallbackLng).toEqual(['es-MX']);
  });
});
