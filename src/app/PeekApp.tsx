import { Toaster } from 'sonner';
import { ProductPeekWindow } from '@widgets/ProductPeekWindow/ui/ProductPeekWindow';
import { ErrorBoundary } from '@shared/ui/ErrorBoundary';
import { AppConfigProvider } from './AppConfigProvider';
import { Providers } from './providers';

/**
 * Provider shell for the "peek" webview window (barcode-scan product detail,
 * Phase 18). Mirrors App.tsx's provider order minus OfflineBanner (no
 * offline-cart concept here, D-04) and ClockDriftBanner (no payment/caja
 * concerns in this window) and minus Router (single fixed widget, no
 * navigation). Reuses <Providers> as-is even though it also mounts
 * CajaListener/OfflineQueueProcessor/UpdaterProvider, none of which this
 * window strictly needs — a peek-only provider subset would be a second
 * maintained abstraction for a two-window app (ponytail: add a stripped
 * variant only if this measurably causes a problem).
 */
export function PeekApp() {
  return (
    <ErrorBoundary>
      <AppConfigProvider>
        <Toaster richColors position="top-right" />
        <Providers>
          <ProductPeekWindow />
        </Providers>
      </AppConfigProvider>
    </ErrorBoundary>
  );
}
