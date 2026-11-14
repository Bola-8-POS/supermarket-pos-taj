import { useWarmNearExpiryPricing } from '@entities/inventory';
import { useStaffStore } from '@entities/staff/model/store';

/**
 * Headless: keeps the near-expiry pricing list for the current threshold fetched (and persisted)
 * for a signed-in session, so an outage that starts before /pos opens still leaves the till able
 * to price the tier. Must be inside QueryClientProvider.
 */
export function NearExpiryPricingWarmer() {
  const isAuthenticated = useStaffStore(state => state.isAuthenticated);
  useWarmNearExpiryPricing(isAuthenticated);
  return null;
}
