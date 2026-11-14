import { useTranslation } from 'react-i18next';
import { getStoreConfigError, storeConfigBlocksBackend } from '@shared/lib/store-mode';

const KNOWN_CODES = [
  'STORE_MODE_UNKNOWN',
  'STORE_URL_REJECTED',
  'STORE_KEY_MISSING',
  'STORE_CA_MISSING',
  'STORE_FILE_UNREADABLE',
];

/**
 * Full-width alert shown on the sell, lock and sign-in screens while a present store.env was refused and the till is
 * blocked (storeConfigBlocksBackend). Names the code, why, and what to do. Nothing from the file itself is shown.
 */
export function StoreConfigBanner() {
  const { t } = useTranslation('common');
  if (!storeConfigBlocksBackend()) return null;
  const code = getStoreConfigError();
  const reason = t(`storeConfig.reason.${KNOWN_CODES.includes(code) ? code : 'OTHER'}`);
  return (
    <div
      role="alert"
      data-testid="store-config-banner"
      data-code={code}
      className="flex min-h-8 shrink-0 items-center justify-center bg-destructive px-3 py-1 text-center text-xs font-semibold text-destructive-foreground"
    >
      {t('storeConfig.banner', { code, reason })}
    </div>
  );
}
