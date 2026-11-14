/**
 * INVENTORY ENTITY - BARREL EXPORT
 */

// Types & Schemas
export { InventorySchema, InventoryLogSchema } from './types';

export type { Inventory } from './types';

// State Management
export { useInventoryStore, inventoryStore, useInventoryRealtimeBridge } from './store';

// Data Fetching
export {
  inventoryKeys,
  useInventory,
  useInventoryAlerts,
  useNearExpiryAlerts,
  useNearExpiryPricingDates,
  useWarmNearExpiryPricing,
  fetchNearExpiryPricingDates,
  NEAR_EXPIRY_PRICING_LOOKAHEAD_DAYS,
  useMutationAdjustInventory,
  useInventoryLog,
} from './queries';

export { stockValue } from './stock-value';
