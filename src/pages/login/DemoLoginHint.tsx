import { useTranslation } from 'react-i18next';
import { DEMO_STAFF } from '@shared/lib/license/demo-accounts';
import { useIsDemo } from '@shared/lib/license/features';

/** Lists the seeded demo staff (name — role — PIN) below the login form. Demo builds only. */
export function DemoLoginHint() {
  const { t } = useTranslation('pages');
  const isDemo = useIsDemo();

  if (!isDemo) return null;

  return (
    <div
      data-testid="demo-login-hint"
      className="mt-6 space-y-2 rounded-xl border border-dashed border-border p-4 text-sm"
    >
      <p className="font-semibold">{t('login.demoHint.title')}</p>
      <ul className="space-y-1 text-muted-foreground">
        {DEMO_STAFF.map(staff => (
          <li key={staff.pin}>
            {staff.name} — {t(`login.demoHint.role.${staff.role}`)} —{' '}
            {t('login.demoHint.pin', { pin: staff.pin })}
          </li>
        ))}
      </ul>
    </div>
  );
}
