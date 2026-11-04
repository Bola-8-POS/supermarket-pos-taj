import { useTranslation } from 'react-i18next';
import { useStoreSchemaStore } from '@shared/lib/store-schema/store';

/**
 * Slim non-blocking strip shown while the store server is fenced for an update (503 STORE_UPDATING).
 * Sales keep queueing (Plan 02 holds the write); this is a status, never an error toast.
 * bottom-7 stacks it just above the 28px LicenseBanner (bottom-0, z-[9997]) so both stay visible.
 */
export function StoreUpdatingBanner() {
  const updating = useStoreSchemaStore(s => s.state.kind === 'updating');
  const { t } = useTranslation('common');
  if (!updating) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="store-updating-banner"
      className="fixed bottom-7 left-0 right-0 z-[9996] flex items-center justify-center bg-warning px-3 py-1.5 text-center text-xs font-semibold text-warning-foreground"
    >
      {t('storeSchema.updating')}
    </div>
  );
}
