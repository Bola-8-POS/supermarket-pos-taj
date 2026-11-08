import { useTranslation } from 'react-i18next';
import { useServerTimeDrift } from '@shared/lib/useServerTimeDrift';

/**
 * Fixed slim warning banner shown below the OfflineBanner when the PC clock
 * drifts more than 2 minutes from the Supabase server clock.
 *
 * Uses amber/yellow to indicate a warning (not a hard error).
 * Positioned below the OfflineBanner via top-7 offset (OfflineBanner occupies ~28px).
 */
export function ClockDriftBanner() {
  const { isDrifting } = useServerTimeDrift();
  const { t } = useTranslation('common');

  if (!isDrifting) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="clock-drift-banner"
      className="fixed top-7 left-0 right-0 z-[9998] flex items-center justify-center py-1.5 px-3 bg-warning text-xs font-semibold text-warning-foreground"
    >
      {t('clockDriftBanner.message')}
    </div>
  );
}
