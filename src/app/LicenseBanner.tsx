import { useTranslation } from 'react-i18next';
import { useLicenseEvaluation } from '@shared/lib/license/store';
import { cn } from '@shared/lib/utils';

/**
 * Slim bottom bar: amber while the subscription (or offline lease) is about to end, red
 * during the post-expiry grace window. Bottom-anchored so it never stacks with the
 * top OfflineBanner / ClockDriftBanner. Renders nothing when active / disabled / locked
 * (locked is handled by LicenseGate).
 */
export function LicenseBanner() {
  const evaluation = useLicenseEvaluation();
  const { t } = useTranslation('common');

  if (evaluation.state !== 'warning' && evaluation.state !== 'grace') return null;

  const message =
    evaluation.state === 'grace'
      ? t('license.banner.grace', { days: evaluation.daysLeft })
      : evaluation.kind === 'lease'
        ? t('license.banner.leaseWarning', { days: evaluation.daysLeft })
        : t('license.banner.subscriptionWarning', { days: evaluation.daysLeft });

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="license-banner"
      data-state={evaluation.state}
      className={cn(
        'fixed bottom-0 left-0 right-0 z-[9997] flex items-center justify-center px-3 py-1.5 text-xs font-semibold',
        evaluation.state === 'grace'
          ? 'bg-destructive text-destructive-foreground'
          : 'bg-warning text-warning-foreground'
      )}
    >
      {message}
    </div>
  );
}
