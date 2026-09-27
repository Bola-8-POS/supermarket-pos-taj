import { ShoppingBasket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { EmployeeSelector } from '@widgets/EmployeeSelector/EmployeeSelector';
import { LogoImage } from '@widgets/LogoImage';
import { PINLoginForm } from '@widgets/PINLoginForm/PINLoginForm';
import { StoreLogoImage, useSettings } from '@entities/settings';
import { useLoginUiStore } from '@entities/staff/model/loginUiStore';
import { useStaffStore } from '@entities/staff/model/store';
import { getTerminalId } from '@shared/lib/terminal';
import { ErrorBoundary } from '@shared/ui';
import { LiveTimeDisplay } from '@shared/ui/LiveTimeDisplay';
import { DemoLoginHint } from './DemoLoginHint';

export default function LoginPage() {
  const { t, i18n } = useTranslation('pages');
  const selectedStaff = useLoginUiStore(s => s.selectedStaff);
  const isAuthenticated = useStaffStore(s => s.isAuthenticated);
  // useSettings() is pending pre-auth on first paint; storeName defaults to '' so the
  // unconfigured branch renders instead of a skeleton (UI-SPEC §1 "Loading state").
  const { data: settingsData } = useSettings();
  const storeName = settingsData?.general.storeName.trim() ?? '';
  const hasStoreLogo = Boolean(settingsData?.general.storeLogoPath);
  const showHero = storeName !== '' || hasStoreLogo;

  if (isAuthenticated) {
    return <Navigate to="/home" replace />;
  }

  const dateLabel = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());

  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden bg-ink text-ink-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_70%_at_0%_100%,var(--brand)_0%,transparent_60%)] opacity-50"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent,color-mix(in_oklch,var(--color-ink)_60%,transparent))]"
        />
        {showHero ? (
          <div className="relative flex flex-col items-start gap-4">
            <div className="flex size-32 items-center justify-center overflow-hidden rounded-3xl bg-ink-foreground/10 p-3 ring-1 ring-ink-foreground/15">
              <StoreLogoImage
                alt={t('login.logoAlt', { name: storeName || t('login.brand') })}
                className="max-h-full max-w-full object-contain"
                fallback={<ShoppingBasket className="size-8" aria-hidden="true" />}
              />
            </div>
            <div className="leading-tight">
              <p data-testid="login-store-name" className="text-3xl font-semibold tracking-tight">
                {storeName || t('login.brand')}
              </p>
              <p className="mt-1 text-xs text-ink-foreground/60">
                {t('login.terminal', { id: getTerminalId() })}
              </p>
            </div>
          </div>
        ) : (
          <div className="relative flex items-center gap-3">
            <div className="flex size-11 items-center justify-center overflow-hidden rounded-xl bg-ink-foreground/10 ring-1 ring-ink-foreground/15">
              <LogoImage
                alt={t('common.logoAlt')}
                className="size-full object-cover"
                fallback={<ShoppingBasket className="size-5" aria-hidden="true" />}
              />
            </div>
            <div className="leading-tight">
              <p data-testid="login-store-name" className="text-sm font-semibold tracking-tight">
                {t('login.brand')}
              </p>
              <p className="text-xs text-ink-foreground/60">
                {t('login.terminal', { id: getTerminalId() })}
              </p>
            </div>
          </div>
        )}

        <div className="relative space-y-6">
          <div className="space-y-2">
            <p className="text-[0.6875rem] font-semibold tracking-[0.14em] text-ink-foreground/60 uppercase">
              {dateLabel}
            </p>
            <LiveTimeDisplay className="block text-6xl font-semibold tracking-tight text-ink-foreground tabular-nums" />
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-ink-foreground/70 text-pretty">
            {t('login.tagline')}
          </p>
        </div>
      </aside>

      {/* Sign-in panel */}
      <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-10 lg:min-h-0">
        <div className="mb-8 flex items-center gap-3 lg:hidden">
          <div className="flex size-10 items-center justify-center overflow-hidden rounded-xl bg-brand text-brand-foreground">
            <LogoImage
              alt={t('common.logoAlt')}
              className="size-full object-cover"
              fallback={<ShoppingBasket className="size-5" aria-hidden="true" />}
            />
          </div>
          <p className="text-sm font-semibold tracking-tight">{t('login.brand')}</p>
        </div>
        <div className="w-full max-w-md animate-fade-up">
          <ErrorBoundary>{!selectedStaff ? <EmployeeSelector /> : <PINLoginForm />}</ErrorBoundary>
          <DemoLoginHint />
        </div>
      </main>
    </div>
  );
}
