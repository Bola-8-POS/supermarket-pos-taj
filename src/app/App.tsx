import { Toaster } from 'sonner';
import { LicenseActivationForm } from '@features/activate-license';
import { IdleLockProvider } from '@features/idle-screen-lock';
import { UpgradeDialog } from '@features/upgrade-license';
import { useUpgradeDialogStore } from '@shared/lib/license/upgrade-dialog-store';
import { ClockDriftBanner } from '@shared/ui/ClockDriftBanner';
import { ErrorBoundary } from '@shared/ui/ErrorBoundary';
import { OfflineBanner } from '@shared/ui/OfflineBanner';
import { AppConfigProvider } from './AppConfigProvider';
import { LicenseBanner } from './LicenseBanner';
import { LicenseGate } from './LicenseGate';
import { Providers } from './providers';
import { Router } from './router';

export function App() {
  return (
    <ErrorBoundary>
      <AppConfigProvider>
        <OfflineBanner />
        <Toaster
          richColors
          position="top-right"
          closeButton
          toastOptions={{
            classNames: {
              toast: 'rounded-xl border-border font-sans shadow-lg',
              title: 'font-medium',
              description: 'text-muted-foreground',
            },
          }}
        />
        <Providers>
          <ClockDriftBanner />
          <LicenseBanner />
          <UpgradeDialog
            activationForm={
              <LicenseActivationForm
                showDemo={false}
                onDone={() => {
                  useUpgradeDialogStore.getState().close();
                }}
              />
            }
          />
          <LicenseGate>
            <IdleLockProvider>
              <Router />
            </IdleLockProvider>
          </LicenseGate>
        </Providers>
      </AppConfigProvider>
    </ErrorBoundary>
  );
}
