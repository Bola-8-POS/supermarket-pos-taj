/**
 * useAddItemToTab — thin wrapper over the existing useMutationAddOrder
 * (entities/tab), for adding one or more line items to a reopened sale.
 *
 * Deliberately does NOT call supabase.rpc('create_order_with_items', ...)
 * directly — useMutationAddOrder already owns the isOnline() offline guard,
 * p_expected_version optimistic-concurrency payload, supabaseQuery error
 * mapping, and query invalidation for that RPC (verified in
 * src/entities/tab/model/queries.ts). Re-implementing any of that here would
 * duplicate already-tested logic (RESEARCH.md Pattern 1).
 *
 * All of a panel's pending "added rows" are submitted as ONE
 * create_order_with_items call (one order, N order_items) — matching D-04's
 * "ONE ManagerPinDialog confirming the whole pending add," not one RPC
 * round-trip per row.
 */
import { useMutationAddOrder } from '@entities/tab/model/queries';

export interface AddItemToTabInput {
  tabId: string;
  staffId: string;
  items: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
  }>;
}

export function useAddItemToTab() {
  const addOrder = useMutationAddOrder();

  async function addItems(input: AddItemToTabInput) {
    return addOrder.mutateAsync({
      tabId: input.tabId,
      order: { staffId: input.staffId, status: 'pending', notes: null },
      items: input.items.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        modifierIds: [],
        modifierPriceDelta: 0,
        notes: null,
      })),
    });
  }

  return { addItems, isPending: addOrder.isPending };
}
