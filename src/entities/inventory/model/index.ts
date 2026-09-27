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
  useMutationAdjustInventory,
  useInventoryLog,
} from './queries';
