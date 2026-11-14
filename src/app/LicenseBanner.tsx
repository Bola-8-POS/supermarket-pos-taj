import { useTranslation } from 'react-i18next';
import { useLicenseEvaluation } from '@shared/lib/license/store';
import { cn } from '@shared/lib/utils';

/**
 * Slim bottom bar: amber while the subscription, offline lease or offline runtime budget is about
 * to run out, red during the post-expiry grace window and while restricted (a licensed store
 * offline too long: the app runs so the shift can be closed, but new business is refused — the
 * bar says which). Not dismissible. Bottom-anchored so it never stacks with the top
 * OfflineBanner / ClockDriftBanner, and mounted outside LicenseGate so it shows on the login
 * screen too. Renders nothing when active / disabled / locked (locked is LicenseGate's job).
 */
export function LicenseBanner() {
  const evaluation = useLicenseEvaluation();
  const { t } = useTranslation('common');

  if (evaluation.state !== 'warning' && evaluation.state !== 'grace' && evaluation.state !== 'restricted') {
    return null;
  }

  const message =
    evaluation.state === 'restricted'
      ? t(`license.banner.restricted.${evaluation.reason}`)
      : evaluation.state === 'grace'
        ? t('license.banner.grace', { days: evaluation.daysLeft })
        : evaluation.kind === 'lease'
          ? t('license.banner.leaseWarning', { days: evaluation.daysLeft })
          : evaluation.kind === 'offline_budget'
            ? t('license.banner.offlineBudgetWarning', { days: evaluation.daysLeft })
            : t('license.banner.subscriptionWarning', { days: evaluation.daysLeft });

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="license-banner"
      data-state={evaluation.state}
      data-reason={evaluation.state === 'restricted' ? evaluation.reason : undefined}
      className={cn(
        'fixed bottom-0 left-0 right-0 z-[9997] flex items-center justify-center px-3 py-1.5 text-center text-xs font-semibold',
        evaluation.state === 'warning'
          ? 'bg-warning text-warning-foreground'
          : 'bg-destructive text-destructive-foreground'
      )}
    >
      {message}
    </div>
  );
}
