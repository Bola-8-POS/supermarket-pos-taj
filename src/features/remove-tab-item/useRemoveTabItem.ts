import { useMutation, useQueryClient } from '@tanstack/react-query';

import { tabKeys } from '@entities/tab/model/queries';
import { isOnline } from '@shared/lib/connectivity';
import i18n from '@shared/lib/i18n';
import { logger } from '@shared/lib/logger-instance';
import {
  err,
  networkOfflineError,
  notFoundError,
  ok,
  supabaseError,
  tabNotOpenError,
  unknownError,
  type Result,
} from '@shared/lib/result';
import { supabase } from '@shared/lib/supabase';

export interface RemoveTabItemInput {
  tabId: string;
  orderId: string;
  itemId: string;
  productId: string;
  quantity: number;
  reason: string;
}

type RemoveTabItemRpcResult = { ok: boolean; code?: string; message?: string };

export function useRemoveTabItem() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: RemoveTabItemInput): Promise<Result<void>> => {
      if (!isOnline()) {
        return err(networkOfflineError());
      }

      const { data, error } = await supabase.rpc('remove_tab_item', {
        p_item_id: input.itemId,
        p_reason: input.reason,
      });

      if (error) {
        logger.error('tab.removeItem.rpc_failed', {
          itemId: input.itemId,
          orderId: input.orderId,
          tabId: input.tabId,
          message: error.message,
        });
        return err(supabaseError(i18n.t('featOrders:removeTabItem.genericError'), undefined, error));
      }

      const parsed = data as RemoveTabItemRpcResult;
      if (!parsed.ok) {
        logger.error('tab.removeItem.rejected', {
          itemId: input.itemId,
          orderId: input.orderId,
          tabId: input.tabId,
          code: parsed.code,
        });
        if (parsed.code === 'NOT_FOUND') {
          return err(notFoundError());
        }
        if (parsed.code === 'TAB_NOT_OPEN') {
          return err(tabNotOpenError());
        }
        return err(unknownError(parsed));
      }

      logger.info('tab.removeItem.succeeded', {
        itemId: input.itemId,
        orderId: input.orderId,
        tabId: input.tabId,
        productId: input.productId,
        quantity: input.quantity,
      });

      return ok(undefined);
    },

    onSuccess: (result, input) => {
      if (!result.ok) return;
      void queryClient.invalidateQueries({ queryKey: tabKeys.detail(input.tabId) });
      void queryClient.invalidateQueries({ queryKey: tabKeys.lists() });
    },
  });

  return {
    removeTabItem: mutation.mutateAsync,
    isPending: mutation.isPending,
  };
}
