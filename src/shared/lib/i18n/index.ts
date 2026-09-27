import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LocaleSchema, type Locale } from '@shared/lib/domain';

import enCommon from './locales/en-US/common.json';
import enEntities from './locales/en-US/entities.json';
import enFeatMgmt from './locales/en-US/featMgmt.json';
import enFeatOrders from './locales/en-US/featOrders.json';
import enPages from './locales/en-US/pages.json';
import enReceipt from './locales/en-US/receipt.json';
import enSettings from './locales/en-US/settings.json';
import enStaff from './locales/en-US/staff.json';
import enWAdmin from './locales/en-US/wAdmin.json';
import enWPanels from './locales/en-US/wPanels.json';
import esCommon from './locales/es-MX/common.json';
import esEntities from './locales/es-MX/entities.json';
import esFeatMgmt from './locales/es-MX/featMgmt.json';
import esFeatOrders from './locales/es-MX/featOrders.json';
import esPages from './locales/es-MX/pages.json';
import esReceipt from './locales/es-MX/receipt.json';
import esSettings from './locales/es-MX/settings.json';
import esStaff from './locales/es-MX/staff.json';
import esWAdmin from './locales/es-MX/wAdmin.json';
import esWPanels from './locales/es-MX/wPanels.json';

// Not needed for this offline, statically-bundled Tauri app:
// - i18next-http-backend (no CDN/server; resources ship in the signed binary)
// - i18next-browser-languagedetector (locale is staff-driven via profiles.locale, not navigator-driven)

// Exported so callers that need to call `i18n.changeLanguage()` immediately
// on module load (staff-store login/rehydrate — see entities/staff/model/store.ts)
// can await init settling first. `i18next.init()` is asynchronous even with
// every resource provided synchronously here (no backend) — a
// `changeLanguage()` call issued before init's own internal `lng` assignment
// resolves is silently overwritten once init completes, reverting the
// language back to the `lng` default below. This bit only the non-default
// (en-US) locale, since a changeLanguage('es-MX') call racing against an
// init default of 'es-MX' produces the same (correct) result either way.
export const i18nReady: Promise<unknown> = i18n.use(initReactI18next).init({
  resources: {
    'es-MX': {
      common: esCommon,
      featOrders: esFeatOrders,
      featMgmt: esFeatMgmt,
      wPanels: esWPanels,
      wAdmin: esWAdmin,
      entities: esEntities,
      pages: esPages,
      settings: esSettings,
      staff: esStaff,
      receipt: esReceipt,
    },
    'en-US': {
      common: enCommon,
      featOrders: enFeatOrders,
      featMgmt: enFeatMgmt,
      wPanels: enWPanels,
      wAdmin: enWAdmin,
      entities: enEntities,
      pages: enPages,
      settings: enSettings,
      staff: enStaff,
      receipt: enReceipt,
    },
  },
  lng: 'es-MX',
  fallbackLng: 'es-MX', // D-02: es-MX is the default locale
  ns: [
    'common',
    'featOrders',
    'featMgmt',
    'wPanels',
    'wAdmin',
    'entities',
    'pages',
    'settings',
    'staff',
    'receipt',
  ],
  defaultNS: 'common',
  interpolation: { escapeValue: false }, // safe: React already escapes JSX children (T-21-04)
  returnNull: false,
});

// ponytail: skipped `declare module 'i18next'` t()-key type augmentation — strict
// per-key typing would churn on every sweep as keys are added across 21-03..21-11;
// the runtime + eslint-plugin-i18next's committed no-literal-string rule (eslint.config.js,
// 21-12) enforce correctness instead. Add when key stability (post-migration) makes
// the augmentation worth the churn.

/**
 * Resolves the currently-active i18next language to a typed {@link Locale}.
 * For non-component consumers (receipts/PDFs, Phase 28's money formatter)
 * that cannot use the useTranslation() hook's `i18n.language`.
 */
export function getCurrentLocale(): Locale {
  const parsed = LocaleSchema.safeParse(i18n.language);
  return parsed.success ? parsed.data : 'es-MX';
}

export default i18n;
