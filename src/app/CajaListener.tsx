import { useCurrentCaja } from '@entities/caja';

/**
 * Headless component — fetches the current open caja session on app mount
 * and keeps useCajaStore in sync. Must be inside QueryClientProvider.
 */
export function CajaListener() {
  useCurrentCaja();
  return null;
}
