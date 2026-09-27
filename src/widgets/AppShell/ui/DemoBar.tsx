import { useTranslation } from 'react-i18next';
import { useIsDemo } from '@shared/lib/license/features';
import { getEffectiveNow, useLicenseStore } from '@shared/lib/license/store';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';
import { Button } from '@shared/ui/button';

/**
 * In-flow banner shown at the top of the routed content while running the demo license,
 * counting down the 14-day trial and offering the upgrade dialog. Renders nothing outside
 * the demo plan (LicenseBanner/LicenseGate cover subscription/lease warnings separately).
 *
 * Lives alongside Sidebar in widgets/AppShell/ui (not app/) — AppShell is a `widgets`-layer
 * file and FSD's enforced import direction (app → pages → widgets → …) forbids widgets
 * from importing app/. DemoBar has no app-only dependency, so it belongs here instead.
 */
export function DemoBar() {
  const { t } = useTranslation('common');
  const isDemo = useIsDemo();
  const payload = useLicenseStore(s => s.payload);
  const openFor = useUpgradeDialogStore(s => s.openFor);

  if (!isDemo || !payload?.period_end) return null;

  const days = Math.max(
    0,
    Math.ceil((new Date(payload.period_end).getTime() - getEffectiveNow()) / 86_400_000)
  );

  return (
    <div
      role="status"
      data-testid="demo-bar"
      data-days-left={days}
      className="flex h-8 shrink-0 items-center justify-center gap-3 bg-warning text-xs font-semibold text-warning-foreground"
    >
      <span>{t('license.demo.bar', { count: days })}</span>
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-xs font-semibold text-warning-foreground underline underline-offset-2"
        onClick={() => {
          openFor();
        }}
      >
        {t('license.demo.cta')}
      </Button>
    </div>
  );
}
