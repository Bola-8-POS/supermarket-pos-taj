import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import type { Inventory } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import { supabase } from '@shared/lib/supabase';
import { inventoryKeys } from './queries';
/* eslint-disable i18next/no-literal-string -- the Realtime channel name below
   is a wire-protocol identifier, not UI copy. */

type LowStockAlertItem = {
  productId: string;
  name: string;
  quantityOnHand: number;
};

interface InventoryState {
  inventory: Inventory[];
  /** Product IDs at or below threshold (derived from `lowStockAlerts`). */
  lowStockProductIds: string[];
  /** Rich list for POS alert bar and tooling. */
  lowStockAlerts: LowStockAlertItem[];
}

interface InventoryActions {
  /** Replaces the full inventory list; called by TanStack Query on success. */
  setInventory: (items: Inventory[]) => void;

  /**
   * Optimistically decrements a product's quantity on hand by the given amount.
   * Clamps to zero — never goes negative.
   */
  decrementQuantity: (productId: string, amount: number) => void;

  /**
   * Merges line quantities by productId, then decrements each in one state update.
   * Used after a successful order (optimistic UI; DB trigger is authoritative).
   */
  decrementQuantities: (lines: { productId: string; quantity: number }[]) => void;

  /** Recomputes low-stock lists from the current inventory list. */
  refreshAlerts: () => void;
}

type InventoryStore = InventoryState & InventoryActions;

function mergeQuantities(lines: { productId: string; quantity: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const { productId, quantity } of lines) {
    if (quantity <= 0) continue;
    map.set(productId, (map.get(productId) ?? 0) + quantity);
  }
  return map;
}

export const useInventoryStore = create<InventoryStore>((set, get) => ({
  inventory: [],
  lowStockProductIds: [],
  lowStockAlerts: [],

  setInventory: items => {
    logger.info('inventory.loaded', { count: items.length });
    set({ inventory: items });
    get().refreshAlerts();
  },

  decrementQuantity: (productId, amount) => {
    if (amount <= 0) return;
    logger.debug('inventory.decrement', { productId, amount });
    set(state => ({
      inventory: state.inventory.map(item =>
        item.productId === productId
          ? { ...item, quantityOnHand: Math.max(0, item.quantityOnHand - amount) }
          : item
      ),
    }));
    get().refreshAlerts();
  },

  decrementQuantities: lines => {
    const merged = mergeQuantities(lines);
    if (merged.size === 0) return;
    logger.debug('inventory.decrement_batch', { productCount: merged.size });
    set(state => ({
      inventory: state.inventory.map(item => {
        const take = merged.get(item.productId);
        if (take === undefined) return item;
        return { ...item, quantityOnHand: Math.max(0, item.quantityOnHand - take) };
      }),
    }));
    get().refreshAlerts();
  },

  refreshAlerts: () => {
    const lowStockAlerts: LowStockAlertItem[] = get()
      .inventory.filter(item => item.quantityOnHand <= item.lowStockThreshold)
      .map(item => ({
        productId: item.productId,
        name: item.product?.name ?? i18n.t('entities:common.unknownProduct'),
        quantityOnHand: item.quantityOnHand,
      }));

    const lowStockProductIds = lowStockAlerts.map(a => a.productId);

    logger.debug('inventory.alerts.refreshed', { lowStockCount: lowStockProductIds.length });
    set({ lowStockProductIds, lowStockAlerts });
  },
}));

/**
 * Same store reference; use for `getState` / `subscribe` outside React.
 *
 * Duplicate-export pair with `useInventoryStore` (both point at the same
 * Zustand store instance) — kept as two names deliberately, not consolidated:
 * `inventoryStore` is the one actually imported by production widgets
 * (`widgets/LowStockAlert/index.tsx`, `widgets/OrderPanel/CartPanel.tsx`),
 * while `useInventoryStore` is used internally within this entities slice
 * (`model/index.ts`, `model/queries.ts`, `model/store.test.ts`). Neither
 * alias is dead — consolidating them would require renaming call sites in
 * src/widgets, which is outside this plan's file scope (entities model/ui
 * files only) and would also be a restructuring change beyond "remove the
 * flagged declaration" (39-10 plan text: "Do not restructure the module").
 * Deferred, not resolved.
 */
export const inventoryStore = useInventoryStore;

/**
 * Subscribes to Supabase Realtime postgres_changes on the inventory table.
 * When any inventory row is inserted, updated, or deleted, invalidates the
 * alerts query so useInventoryAlerts() refetches automatically.
 *
 * Mount this hook once in a top-level widget or provider — never in a list component.
 */
export function useInventoryRealtimeBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidateAlerts = () => {
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.alerts() });
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.lowStock() });
    };

    const ch = supabase
      .channel('inventory:changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => {
        logger.debug('inventory.realtime.change');
        invalidateAlerts();
        // Also refresh Zustand alert list on the next tick after TanStack refetch
        useInventoryStore.getState().refreshAlerts();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(ch);
    };
  }, [queryClient]);
}
