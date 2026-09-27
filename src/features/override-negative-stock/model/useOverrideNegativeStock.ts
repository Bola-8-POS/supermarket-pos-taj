/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * override-negative-stock feature
 *
 * Called after manager PIN approval when create_order_with_items raised INVENTORY_NEGATIVE.
 *
 * Flow:
 * 1. Place the order with p_skip_depletion=true (no INVENTORY_NEGATIVE guard)
 * 2. Deplete each order_item with p_allow_negative=true (bypasses guard, writes audit_log in DB)
 * 3. Write a top-level audit_log row for the override decision
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { tabKeys } from '@entities/tab/model/queries';
import { logger } from '@shared/lib/logger-instance';
import { err, ok, type Result } from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

const db = supabase as any;

type OverrideOrderItem = {
  productId: string;
  quantity: number;
  unitPrice: number;
  modifierIds: string[];
  modifierPriceDelta: number;
  notes: string | null;
};

export type OverrideInput = {
  tabId: string;
  staffId: string;
  items: OverrideOrderItem[];
  actorId: string; // bartender who placed the original order (manager ID not exposed by ManagerPinDialog)
};

export function useOverrideNegativeStock() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: OverrideInput): Promise<Result<void>> => {
      // 1. Place order WITHOUT depletion guard (p_skip_depletion=true)
      const rpcItems = input.items.map(item => ({
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        modifier_price_delta: item.modifierPriceDelta,
        notes: item.notes,
        modifier_ids: item.modifierIds,
      }));

      // create_order_with_items has required p_status/p_notes params (added
      // 20260428000003, before p_expected_version was ever appended) — this
      // call never included them, so every override attempt 404'd
      // ("Could not find the function ... with parameters p_items,
      // p_skip_depletion, p_staff_id, p_tab_id") instead of placing the
      // order. p_status mirrors the normal add-order path's fixed 'pending'
      // (useMutationAddOrder); this override flow has no notes to carry.
      const { data: orderData, error: orderError } = await db.rpc('create_order_with_items', {
        p_tab_id: input.tabId,
        p_staff_id: input.staffId,
        p_status: 'pending',
        p_notes: '',
        p_items: rpcItems,
        p_skip_depletion: true,
      });

      if (orderError) {
        logger.error('override_negative_stock.place_order_failed', {
          error: orderError,
          tabId: input.tabId,
        });
        return err({ code: 'SUPABASE_ERROR', message: (orderError as { message: string }).message });
      }

      // 2. Deplete each inserted order_item with p_allow_negative=true
      // create_order_with_items returns { order, items } (see
      // mapRpcOrderPayload in entities/tab/model/queries.ts) — this read the
      // wrong key (`order_items`, which is never present on the RPC
      // response), so `orderItems` was always `[]` and the depletion loop
      // below silently never ran. The order itself still got placed (step 1
      // succeeds independently), which is why this failure mode produced no
      // error anywhere — just an order with none of its open-unit/ingredient
      // depletion applied.
      const orderItems = (orderData as { items?: { id: string }[] }).items ?? [];

      for (const item of orderItems) {
        const { error: deplError } = await db.rpc('deplete_for_order_item', {
          p_order_item_id: item.id,
          p_direction: 1,
          p_allow_negative: true,
        });
        if (deplError) {
          // Log but continue — order is placed; depletion failure is recoverable
          logger.warn('override_negative_stock.depletion_failed', {
            orderItemId: item.id,
            tabId: input.tabId,
            errorCode: (deplError as { code?: string }).code,
          });
        }
      }

      // 3. Write top-level audit_log row for the override event
      /* eslint-disable i18next/no-literal-string -- fixed audit_log action/entity_type identifiers, not UI copy */
      const { error: auditError } = await db.from('audit_log').insert({
        action: 'override_negative_stock',
        actor_id: input.actorId,
        entity_type: 'tab',
        entity_id: input.tabId,
        details: {
          orderItemCount: orderItems.length,
          approvedAt: new Date().toISOString(),
        },
      });
      /* eslint-enable i18next/no-literal-string */

      if (auditError) {
        logger.warn('override_negative_stock.audit_log_failed', { error: auditError });
        // Don't fail the mutation — order is placed
      }

      logger.info('override_negative_stock.completed', {
        tabId: input.tabId,
        orderItemCount: orderItems.length,
      });

      return ok(undefined);
    },
    onSuccess: (result) => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: tabKeys.lists() });
    },
  });
}
