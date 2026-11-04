import { describe, expect, it } from 'vitest';
import i18n from '@shared/lib/i18n';
import enUS from '@shared/lib/i18n/locales/en-US/featOrders.json';
import esMX from '@shared/lib/i18n/locales/es-MX/featOrders.json';
import {
  OFFLINE_REASON_PARAMS,
  OFFLINE_REFUSAL_REASONS,
  offlineReasonKey,
  offlineReasonOf,
} from './offlineReasons';

type Catalog = { offlineCheckout?: { reason?: Record<string, unknown> } };

describe('offline refusal reasons', () => {
  it('every offline refusal reason has a message in both locales', () => {
    for (const [locale, catalog] of [
      ['en-US', enUS],
      ['es-MX', esMX],
    ] as const) {
      const reasons = (catalog as Catalog).offlineCheckout?.reason ?? {};
      for (const reason of OFFLINE_REFUSAL_REASONS) {
        const message = reasons[reason];
        expect(typeof message === 'string' && message.length > 0, `${locale}: ${reason}`).toBe(true);
      }
    }
  });

  it('every offline refusal reason renders to real words in both locales', () => {
    for (const lng of ['en-US', 'es-MX']) {
      for (const reason of OFFLINE_REFUSAL_REASONS) {
        const text = i18n.t(offlineReasonKey(reason), { lng, ...OFFLINE_REASON_PARAMS });
        expect(text, `${lng}: ${reason}`).not.toContain('offlineCheckout');
        expect(text, `${lng}: ${reason}`).not.toContain('{{');
        expect(text.length, `${lng}: ${reason}`).toBeGreaterThan(10);
      }
    }
    // the interpolated limits really arrive
    expect(i18n.t(offlineReasonKey('limit_count'), { lng: 'en-US', ...OFFLINE_REASON_PARAMS })).toContain('500');
    expect(i18n.t(offlineReasonKey('limit_age'), { lng: 'es-MX', ...OFFLINE_REASON_PARAMS })).toContain('24');
  });

  it('reads the reason only from an offline refusal', () => {
    expect(offlineReasonOf({ code: 'NETWORK_OFFLINE', details: 'card_reference_missing' })).toBe(
      'card_reference_missing'
    );
    expect(offlineReasonOf({ code: 'NETWORK_OFFLINE', details: 'limit_age' })).toBe('limit_age');
    // a server refusal carries a details string too: never a reason, even one that looks like it
    expect(offlineReasonOf({ code: 'DIRECT_SALE_FAILED', details: 'method' })).toBeNull();
    expect(offlineReasonOf({ code: 'NETWORK_OFFLINE', details: 'AMOUNT_MISMATCH: moved' })).toBeNull();
    expect(offlineReasonOf({ code: 'NETWORK_OFFLINE' })).toBeNull();
    // prototype keys are not reasons
    expect(offlineReasonOf({ code: 'NETWORK_OFFLINE', details: 'toString' })).toBeNull();
    expect(offlineReasonOf({ code: 'NETWORK_OFFLINE', details: 'constructor' })).toBeNull();
  });

  it('keys each reason under the offline checkout catalog', () => {
    expect(offlineReasonKey('rering')).toBe('featOrders:offlineCheckout.reason.rering');
  });
});
